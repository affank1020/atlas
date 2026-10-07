import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AtlasError } from '../../shared/errors.js';

export const MAX_FILE_BYTES = 512 * 1024;
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const within = (root: string, target: string) => target === root || target.startsWith(root + path.sep);
const excluded = /^(?:\.git|\.hg|\.svn|\.ssh|\.aws|\.azure|\.gnupg|node_modules|Library|Temp|Logs|Obj|Build|Builds|dist|build|obj|bin|UserSettings|\.atlas-tmp-.*)$/i;
const secret = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|credentials?(?:[-_.].*)?|secrets?(?:[-_.].*)?|tokens?(?:[-_.].*)?|service[-_]account(?:[-_.].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|keystore))$/i;
export function permitted(relative: string) {
    return !path.isAbsolute(relative) && !relative.includes('\\') && !relative.includes('\0') && !relative.split('/').some(p => p === '..' || excluded.test(p) || secret.test(p));
}
export class WorkspaceFiles {
    constructor(readonly roots: string[]) {}
    async bind(root: string) {
        if (!path.isAbsolute(root)) throw new AtlasError('Workspace root must be absolute.');
        const canonical = await fs.realpath(root);
        if (!(await fs.stat(canonical)).isDirectory()) throw new AtlasError('Workspace root must be a directory.');
        let allowed = false;
        for (const root of this.roots) { try { if (within(await fs.realpath(root), canonical)) allowed = true; } catch { /* A missing allow-list root grants no access. */ } }
        if (!allowed) throw new AtlasError('Workspace is outside ATLAS_WORKSPACE_ROOTS.', 'WORKSPACE_DENIED');
        // An allow-listed parent must not expose private/generated subdirectories as separate workspaces.
        if (canonical.split(path.sep).some(p => excluded.test(p) || secret.test(p))) throw new AtlasError('Protected workspace root.', 'WORKSPACE_DENIED');
        return canonical;
    }
    async resolve(root: string, relative: string, missing = false) {
        if (!permitted(relative)) throw new AtlasError('Protected or invalid workspace path.', 'WORKSPACE_DENIED');
        if (await this.bind(root) !== root) throw new AtlasError('Workspace root has moved.', 'WORKSPACE_DENIED');
        const parts = relative.split('/').filter(p => p && p !== '.');
        let current = root;
        for (let index = 0; index < parts.length; index++) {
            current = path.join(current, parts[index]!);
            try {
                const stat = await fs.lstat(current);
                if (stat.isSymbolicLink()) throw new AtlasError('Symlinks are not exposed by workspaces.', 'WORKSPACE_DENIED');
                if (!within(root, await fs.realpath(current))) throw new AtlasError('Workspace path escaped.', 'WORKSPACE_DENIED');
            } catch (error: any) { if (!(missing && index === parts.length - 1 && error.code === 'ENOENT')) throw error; }
        }
        return current;
    }
    async read(root: string, relative: string) {
        const target = await this.resolve(root, relative);
        const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.nlink !== 1) throw new AtlasError('Only regular, non-hard-linked files are supported.', 'UNSUPPORTED_FILE');
            if (stat.size > MAX_FILE_BYTES) throw new AtlasError('File exceeds 512 KiB.', 'FILE_TOO_LARGE');
            const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
            let bytesRead = 0;
            while (bytesRead < buffer.length) {
                const read = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
                if (!read.bytesRead) break; bytesRead += read.bytesRead;
            }
            if (bytesRead > MAX_FILE_BYTES) throw new AtlasError('File exceeds 512 KiB.', 'FILE_TOO_LARGE');
            let text: string;
            try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytesRead)); } catch { throw new AtlasError('Only UTF-8 text files are supported.', 'UNSUPPORTED_FILE'); }
            if (text.includes('\0') || /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(text)) throw new AtlasError('Binary or private-key content is protected.', 'UNSUPPORTED_FILE');
            return { path: relative, text, bytes: bytesRead, sha256: hash(text), modifiedAt: stat.mtime.toISOString() };
        } finally { await file.close(); }
    }
    async list(root: string, relative = '', depth = 4, limit = 500) {
        const entries: { path: string; type: 'file' | 'directory' }[] = [];
        let truncated = false, visited = 0;
        const walk = async (dir: string, level: number) => {
            const target = await this.resolve(root, dir);
            // Bound directory scanning as well as returned entries.
            const handle = await fs.opendir(target); const names: string[] = [];
            for await (const item of handle) { if (++visited > 10000) { truncated = true; break; } names.push(item.name); }
            for (const name of names.sort()) {
                const rel = dir ? `${dir}/${name}` : name;
                if (!permitted(rel)) continue;
                if (entries.length >= limit) { truncated = true; break; }
                const stat = await fs.lstat(await this.resolve(root, dir) + path.sep + name);
                if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) continue;
                entries.push({ path: rel, type: stat.isDirectory() ? 'directory' : 'file' });
                if (stat.isDirectory()) { if (level < depth && visited <= 10000) await walk(rel, level + 1); else truncated = true; }
            }
        };
        await walk(relative, 0); return { entries, truncated };
    }
    async search(root: string, query: string, relative = '', limit = 100) {
        const listing = await this.list(root, relative, 20, 2000);
        const matches: { path: string; line: number; text: string }[] = [];
        let skipped = 0, bytes = 0;
        for (const entry of listing.entries) {
            if (entry.type !== 'file') continue;
            if (bytes >= 8 * 1024 * 1024) return { matches, skipped, truncated: true };
            try {
                const file = await this.read(root, entry.path); bytes += file.bytes;
                const lines = file.text.split('\n');
                for (let i = 0; i < lines.length; i++) if (lines[i]!.includes(query)) {
                    if (matches.length === limit) return { matches, skipped, truncated: true };
                    const index = lines[i]!.indexOf(query);
                    matches.push({ path: entry.path, line: i + 1, text: lines[i]!.slice(Math.max(0, index - 100), index + 400) });
                }
            } catch (error) { if (error instanceof AtlasError) skipped++; else throw error; }
        }
        return { matches, skipped, truncated: listing.truncated };
    }
    validateText(text: string) {
        if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new AtlasError('File exceeds 512 KiB.', 'FILE_TOO_LARGE');
        if (text.includes('\0') || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) throw new AtlasError('Binary/private-key content is unsupported.');
    }
    async create(root: string, relative: string, text: string) {
        this.validateText(text);
        const target = await this.resolve(root, relative, true);
        const file = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
        try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
        return { path: relative, sha256: hash(text), bytes: Buffer.byteLength(text) };
    }
    async patch(root: string, relative: string, expected: string, oldText: string, newText: string) {
        const before = await this.read(root, relative);
        if (before.sha256 !== expected) throw new AtlasError('File changed; read it again before editing.', 'CONFLICT');
        const offset = before.text.indexOf(oldText);
        if (!oldText || offset < 0 || before.text.indexOf(oldText, offset + 1) >= 0) throw new AtlasError('oldText must match exactly once.', 'CONFLICT');
        const text = before.text.slice(0, offset) + newText + before.text.slice(offset + oldText.length);
        this.validateText(text);
        const target = await this.resolve(root, relative);
        const temp = path.join(path.dirname(target), `.atlas-tmp-${randomUUID()}`);
        try {
            const file = await fs.open(temp, 'wx', (await fs.stat(target)).mode & 0o777);
            try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
            if ((await this.read(root, relative)).sha256 !== expected) throw new AtlasError('Concurrent file change.', 'CONFLICT');
            await this.resolve(root, relative);
            await fs.rename(temp, target);
        } finally { await fs.unlink(temp).catch(() => undefined); }
        return { path: relative, previousSha256: expected, sha256: hash(text), bytes: Buffer.byteLength(text) };
    }
    async delete(root: string, relative: string, expected: string) {
        if ((await this.read(root, relative)).sha256 !== expected) throw new AtlasError('File changed; read it again before deleting.', 'CONFLICT');
        await fs.unlink(await this.resolve(root, relative)); return { path: relative, previousSha256: expected, deleted: true };
    }
}
const exec = promisify(execFile);
export async function git(root: string, files: WorkspaceFiles, diff = false) {
    await files.resolve(root, '');
    try {
        const metadata = await fs.lstat(path.join(root, '.git'));
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) return { available: false, reason: 'V1 requires an in-workspace .git directory; linked worktrees/submodules are not exposed.' };
        if (!within(root, await fs.realpath(path.join(root, '.git')))) throw new AtlasError('Git metadata escaped the workspace.');
    } catch { return { available: false, reason: 'Not a Git repository root.' }; }
    const run = async (args: string[]) => (await exec('/usr/bin/git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
        timeout: 10000, maxBuffer: 1024 * 1024,
        env: { PATH: '/usr/bin:/bin', HOME: '/var/empty', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    })).stdout;
    try { if (await fs.realpath((await run(['rev-parse', '--show-toplevel'])).trim()) !== root) return { available: false, reason: 'Workspace is not a Git repository root.' }; }
    catch { return { available: false, reason: 'Not a Git repository (or Git unavailable).' }; }
    const raw = await run(['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
    const tokens = raw.split('\0'); const changes: { status: string; path: string }[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!; if (!token) continue;
        const status = token.slice(0, 2), relative = token.slice(3);
        if (/[RC]/.test(status)) i++;
        if (permitted(relative)) changes.push({ status, path: relative });
    }
    const branch = (await run(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => 'HEAD')).trim();
    if (!diff) return { available: true, branch, dirty: raw.length > 0, changes: changes.slice(0, 500), truncated: changes.length > 500 };
    // Only expose diffs for safe current text files; deleted/binary/private paths are omitted.
    const paths: string[] = [];
    for (const entry of changes.slice(0, 100)) { try { await files.read(root, entry.path); paths.push(`:(literal)${entry.path}`); } catch { /* protected/removed files omitted */ } }
    if (!paths.length) return { available: true, diff: '', omitted: changes.length };
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color'];
    const text = await run([...args, '--', ...paths]);
    const staged = await run([...args, '--cached', '--', ...paths]);
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text + staged)) throw new AtlasError('Diff contains private-key material.', 'WORKSPACE_DENIED');
    return { available: true, diff: text, stagedDiff: staged, omitted: changes.length - paths.length };
}
