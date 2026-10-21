import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath, rmdir, readdir, lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { AtlasError } from '@atlas/protocol/errors';
import { verifyGitLayout, type WorkspaceFiles } from './files.js';

const exec = promisify(execFile);
const branchAllowed = (branch: string) =>
    /^atlas\/[a-z0-9][a-z0-9/_-]{0,72}$/.test(branch) &&
    !branch.includes('//') && !branch.endsWith('/');
const within = (parent: string, child: string) =>
    child.startsWith(parent + path.sep);
const env = {
    PATH: '/usr/bin:/bin', HOME: '/var/empty',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
};
async function run(root: string, args: string[], extraEnv: Record<string, string> = {}) {
    try {
        return (await exec('/usr/bin/git',
            ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                '-C', root, ...args],
            // ls-tree -r can exceed 128 KiB for ordinary medium-sized repositories.
            // Keep a bounded but practical cap; oversized trees fail closed.
            { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...env, ...extraEnv } })).stdout.trim();
    } catch (error) {
        // Never surface Git stderr: repository metadata can contain private URLs.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ETIMEDOUT') throw new AtlasError('Git operation timed out.', 'CONFLICT');
        throw new AtlasError('Git worktree operation failed; inspect the checkout locally.', 'CONFLICT');
    }
}
async function trustedTarget(target: string, files: WorkspaceFiles) {
    if (!path.isAbsolute(target) || path.resolve(target) !== target ||
        target.includes('\0') || path.basename(target).startsWith('.'))
        throw new AtlasError('Worktree target must be an absolute canonical-looking directory path.', 'INVALID_REQUEST');
    const parent = path.dirname(target);
    if (await realpath(parent) !== parent) throw new AtlasError('Worktree parent must be canonical.', 'WORKSPACE_DENIED');
    await files.bind(parent);
    let trusted = false;
    for (const configured of (process.env.ATLAS_GIT_TRUSTED_ROOTS ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
        if (!path.isAbsolute(configured)) continue;
        try {
            if (await realpath(configured) === configured && within(configured, target)) trusted = true;
        } catch { /* An unavailable configured path grants nothing. */ }
    }
    if (!trusted) throw new AtlasError('Worktree target is outside the trusted Git roots.', 'WORKSPACE_DENIED');
    return parent;
}
interface Worktree { rootPath: string; head: string; branch: string | null; detached: boolean; }
function parseWorktrees(raw: string): Worktree[] {
    const results: Worktree[] = [];
    for (const group of raw.split(/\n\n+/).filter(Boolean)) {
        const fields = group.split('\n');
        const name = fields.find(s => s.startsWith('worktree '))?.slice(9);
        const head = fields.find(s => s.startsWith('HEAD '))?.slice(5);
        const ref = fields.find(s => s.startsWith('branch refs/heads/'))?.slice(18);
        if (!name || !head || !/^[a-f0-9]{40}$/.test(head)) continue;
        results.push({ rootPath: name, head, branch: ref || null,
            detached: fields.includes('detached') });
    }
    if (results.length > 100) throw new AtlasError('Too many linked Git worktrees.', 'CAPABILITY_UNAVAILABLE');
    return results;
}
async function allWorktrees(root: string, files: WorkspaceFiles) {
    await verifyGitLayout(root, files);
    if (await realpath(root) !== root) throw new AtlasError('Workspace checkout path is not canonical.', 'WORKSPACE_DENIED');
    if (await run(root, ['rev-parse', '--show-toplevel']) !== root)
        throw new AtlasError('Workspace must be the repository root.', 'WORKSPACE_DENIED');
    return parseWorktrees(await run(root, ['worktree', 'list', '--porcelain']));
}
export async function listManagedWorktrees(root: string, files: WorkspaceFiles) {
    const entries = await allWorktrees(root, files);
    const visible: Worktree[] = [];
    for (const entry of entries) {
        try {
            const canonical = await realpath(entry.rootPath);
            if (canonical !== entry.rootPath) continue;
            await files.bind(canonical);
            visible.push(entry);
        } catch { /* Never expose unapproved worktree paths. */ }
    }
    return { worktrees: visible };
}
export async function createManagedWorktree(root: string, files: WorkspaceFiles,
    branch: string, targetPath: string) {
    if (!branchAllowed(branch)) throw new AtlasError('Only atlas/* branches can be created.', 'INVALID_REQUEST');
    await allWorktrees(root, files);
    await trustedTarget(targetPath, files);
    // Atomic reservation: Git also accepts an already-empty directory.
    // Never follow a destination symlink created between validation and Git.
    try { await mkdir(targetPath, { mode: 0o700 }); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            throw new AtlasError('Worktree target already exists.', 'CONFLICT');
        throw error;
    }
    let head: string;
    try {
        head = await run(root, ['rev-parse', 'HEAD']);
        await run(root, ['worktree', 'add', '-b', branch, targetPath, head]);
    } catch (error) {
        await rmdir(targetPath).catch(() => undefined); // Only if Git left it empty.
        throw error;
    }
    const registered = (await allWorktrees(root, files)).find(x =>
        x.rootPath === targetPath && x.branch === branch && x.head === head);
    if (!registered) throw new AtlasError('Worktree creation outcome is uncertain; inspect the repository.', 'OUTCOME_UNCERTAIN');
    return { rootPath: targetPath, branch, head, sourceHead: head };
}
/** Approximate actual allocated disk blocks rather than claiming every logical
 * file byte will be reclaimed. No symlink traversal or unbounded recursion. */
async function estimateCheckoutBytes(target: string): Promise<number> {
    const pending = [target];
    let entries = 0;
    let blocks = 0;
    while (pending.length) {
        const directory = pending.pop()!;
        for (const item of await readdir(directory, { withFileTypes: true })) {
            if (++entries > 100_000)
                throw new AtlasError('Worktree size inspection exceeds its safe file limit.', 'CAPABILITY_UNAVAILABLE');
            const entry = path.join(directory, item.name);
            const info = await lstat(entry);
            blocks += (info.blocks ?? Math.ceil(info.size / 512)) * 512;
            if (item.isDirectory()) pending.push(entry);
        }
    }
    return blocks;
}

/** An active shell, editor or task whose working directory is inside the
 * checkout can make retirement destructive. Fail closed without revealing
 * unrelated processes. No arbitrary commands or user-provided executable. */
async function assertNoActiveWorkingDirectories(target: string) {
    // Prefer the OS process-file inspector. Linux procfs can deny same-UID
    // cwd inspections in CI/container namespaces even when no checkout user
    // is active. An unavailable lsof falls back to procfs, never "safe".
    const lsof = process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof';
    try {
        const output = (await exec(lsof, ['-nP', '-d', 'cwd', '-Fn'], {
            timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
            env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        })).stdout;
        if (output.split('\n').some(line => line.startsWith('n') &&
            (line.slice(1) === target || within(target, line.slice(1)))))
            throw new AtlasError('A process is currently working inside this worktree; local files were preserved.', 'CONFLICT');
        return;
    } catch (error) {
        if (error instanceof AtlasError) throw error;
        if (process.platform !== 'linux' || (error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw new AtlasError('Cannot verify active worktree processes; local files were preserved.', 'CAPABILITY_UNAVAILABLE');
    }

    // Linux fallback for VPS installations without lsof. Inspect same-UID
    // process working directories, without reading argv or environment.
    let processes: string[];
    try { processes = (await readdir('/proc')).filter(name => /^[0-9]+$/.test(name)); }
    catch { throw new AtlasError('Cannot inspect running processes; local files were preserved.', 'CAPABILITY_UNAVAILABLE'); }
    if (processes.length > 4096)
        throw new AtlasError('Too many processes to verify safe retirement.', 'CAPABILITY_UNAVAILABLE');
    for (const pid of processes) {
        try {
            const status = await readFile(`/proc/${pid}/status`, 'utf8');
            const uid = status.match(/^Uid:\s+(\d+)/m)?.[1];
            if (uid === undefined) throw new Error('Could not verify process ownership');
            if (Number(uid) !== process.getuid?.()) continue;
            const cwd = await readlink(`/proc/${pid}/cwd`);
            if (cwd === target || within(target, cwd))
                throw new AtlasError('A process is currently working inside this worktree; local files were preserved.', 'CONFLICT');
        } catch (error) {
            if (error instanceof AtlasError) throw error;
            if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
            throw new AtlasError('Cannot verify active worktree processes; local files were preserved.', 'CAPABILITY_UNAVAILABLE');
        }
    }
}

/** Git status can hide local modifications for assume-unchanged and
 * skip-worktree index entries. Git worktree remove may still delete them.
 * Refuse any flagged tracked entry, including sparse-checkout entries,
 * rather than trusting a misleading clean porcelain status. */
async function assertNoHiddenTrackedFiles(targetPath: string) {
    // -v shows lowercase tags for assume-unchanged and S for skip-worktree.
    // -z protects filenames with newlines, spaces, and unusual characters.
    const index = await run(targetPath, ['ls-files', '-v', '-z', '--cached']);
    for (const entry of index.split('\0')) {
        if (!entry) continue;
        if (entry.length < 3 || entry[1] !== ' ')
            throw new AtlasError('Could not inspect Git index flags; local files were preserved.', 'CONFLICT');
        const tag = entry[0]!;
        if (tag === 'S' || (tag >= 'a' && tag <= 'z'))
            throw new AtlasError('Worktree has assume-unchanged or skip-worktree Git index flags; local files were preserved.', 'CONFLICT');
    }
}

/** Read-only inspection; deletion repeats these checks immediately before Git removal. */
export async function preflightManagedWorktreeRetirement(root: string, files: WorkspaceFiles,
    targetPath: string, expectedHead: string, expectedBranch: string) {
    const entries = await allWorktrees(root, files);
    if (!branchAllowed(expectedBranch)) throw new AtlasError('Invalid expected managed branch.', 'WORKSPACE_DENIED');
    if (targetPath === root) throw new AtlasError('Cannot remove the parent checkout.', 'WORKSPACE_DENIED');
    await trustedTarget(targetPath, files);
    const target = entries.find(x => x.rootPath === targetPath);
    if (!target || !target.branch || !branchAllowed(target.branch))
        throw new AtlasError('Target is not an Atlas-managed feature worktree.', 'WORKSPACE_DENIED');
    if (target.branch !== expectedBranch) throw new AtlasError('Worktree branch changed since Atlas created it.', 'CONFLICT');
    if (target.head !== expectedHead) throw new AtlasError('Worktree HEAD changed.', 'CONFLICT');
    await verifyGitLayout(targetPath, files);
    if (await run(targetPath, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']))
        throw new AtlasError('Worktree has uncommitted, untracked or ignored files; local files were preserved.', 'CONFLICT');
    // This check is REQUIRED even when porcelain reports a clean checkout.
    await assertNoHiddenTrackedFiles(targetPath);
    await assertNoActiveWorkingDirectories(targetPath);
    const estimatedReclaimedBytes = await estimateCheckoutBytes(targetPath);
    return { eligible: true, rootPath: targetPath, head: expectedHead,
        branch: target.branch, estimatedReclaimedBytes };
}

export async function removeManagedWorktree(root: string, files: WorkspaceFiles,
    targetPath: string, expectedHead: string, expectedBranch: string) {
    const preflight = await preflightManagedWorktreeRetirement(root, files, targetPath, expectedHead, expectedBranch);
    // No --force, no recursive fs deletion and NO branch deletion. A failed Git
    // removal preserves local data; successful Git removal deletes the checkout.
    await run(root, ['worktree', 'remove', targetPath]);
    if ((await allWorktrees(root, files)).some(x => x.rootPath === targetPath))
        throw new AtlasError('Worktree removal outcome is uncertain.', 'OUTCOME_UNCERTAIN');
    try {
        await lstat(targetPath);
        throw new AtlasError('Git removed the worktree registration but its local directory still exists.', 'OUTCOME_UNCERTAIN');
    } catch (error) {
        if (error instanceof AtlasError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw new AtlasError('Could not verify removal of the local directory.', 'OUTCOME_UNCERTAIN');
    }
    return { removed: true, rootPath: targetPath, preservedBranch: preflight.branch, head: expectedHead, estimatedReclaimedBytes: preflight.estimatedReclaimedBytes };
}

/** A repository-management Workspace is rooted at an explicitly configured
 * Git development directory. Cloning never overwrites existing paths and
 * receives a short-lived read token through a child-process environment, not
 * the argv, logs or any stored Workspace metadata. */
export async function cloneManagedRepository(root: string, files: WorkspaceFiles,
    repository: string, directoryName: string, githubToken: string) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(directoryName))
        throw new AtlasError('Invalid GitHub repository or destination directory.', 'INVALID_REQUEST');
    if (typeof githubToken !== 'string' || githubToken.length < 20)
        throw new AtlasError('Missing brokered GitHub credential.', 'CAPABILITY_UNAVAILABLE');
    if (await files.bind(root) !== root)
        throw new AtlasError('Repository-management Workspace root has moved.', 'WORKSPACE_DENIED');
    const roots = (process.env.ATLAS_GIT_TRUSTED_ROOTS || '').split(',').map(s => s.trim());
    if (!roots.includes(root) || await realpath(root) !== root)
        throw new AtlasError('Repository cloning requires a dedicated trusted Git development root Workspace.', 'WORKSPACE_DENIED');
    const target = path.join(root, directoryName);
    try { await mkdir(target, { mode: 0o700 }); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            throw new AtlasError('Repository destination already exists.', 'CONFLICT');
        throw error;
    }
    const auth = Buffer.from('x-access-token:' + githubToken).toString('base64');
    try {
        // Only the default branch's tip is needed to create new atlas/* worktrees.
        // Avoid downloading an entire repository history onto a capacity-limited Node.
        await run(root, ['-c', 'http.followRedirects=false', 'clone', '--depth=1',
            '--single-branch', '--no-checkout', '--no-recurse-submodules',
            '--origin', 'origin', '--', 'https://github.com/' + repository + '.git', target], {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
            GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + auth,
        });
    } catch (error) {
        await rmdir(target).catch(() => undefined); // Never recursively delete partial Git data.
        throw error;
    }
    const head = await run(target, ['rev-parse', '--verify', 'HEAD']);
    const entries = await run(target, ['ls-tree', '-rz', 'HEAD']);
    // Git normally materialises symlinks on checkout. Reject such repositories
    // before checkout so Node-managed directories contain only regular files.
    if (entries.split('\0').some(line => /^(120000|160000)\s/.test(line)))
        throw new AtlasError('Repository contains symlinks or submodules; checkout was not materialised.', 'WORKSPACE_DENIED');
    await run(target, ['reset', '--hard', 'HEAD']);
    if (await files.bind(target) !== target)
        throw new AtlasError('Cloned repository is not under approved Workspace roots.', 'WORKSPACE_DENIED');
    const branch = await run(target, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return { rootPath: target, repository, head, branch };
}
