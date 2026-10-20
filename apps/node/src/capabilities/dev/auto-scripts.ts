import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { DevTask } from '@atlas/protocol/dev-tasks';

/** Only well-known, non-mutating script names are callable by MCP. */
const allowedScripts = ['build', 'test', 'lint', 'typecheck', 'check'] as const;
const packageManagers = ['npm', 'pnpm', 'yarn', 'bun'] as const;
type PackageManager = typeof packageManagers[number];
const MAX_MANIFEST_BYTES = 128 * 1024;

async function hasRegularFile(root: string, name: string): Promise<boolean> {
    try { return (await lstat(join(root, name))).isFile(); }
    catch { return false; }
}

/** Do not follow symlinks or accept an unbounded/malformed manifest. */
async function readPackageManifest(root: string): Promise<Record<string, unknown> | undefined> {
    let handle;
    try {
        handle = await open(join(root, 'package.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 2 || stat.size > MAX_MANIFEST_BYTES) return undefined;
        const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_MANIFEST_BYTES) return undefined;
        const parsed: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch { return undefined; }
    finally { await handle?.close(); }
}

/** An explicit packageManager wins. Ambiguous lockfiles fail closed. */
async function detectPackageManager(root: string, manifest: Record<string, unknown>): Promise<PackageManager | undefined> {
    if (manifest.packageManager !== undefined) {
        if (typeof manifest.packageManager !== 'string') return undefined;
        return manifest.packageManager.match(/^(npm|pnpm|yarn|bun)@/)?.[1] as PackageManager | undefined;
    }
    const locks: Array<[PackageManager, string[]]> = [
        ['pnpm', ['pnpm-lock.yaml']],
        ['yarn', ['yarn.lock']],
        ['bun', ['bun.lock', 'bun.lockb']],
        ['npm', ['package-lock.json', 'npm-shrinkwrap.json']],
    ];
    const present: PackageManager[] = [];
    for (const [manager, names] of locks) {
        if ((await Promise.all(names.map(name => hasRegularFile(root, name)))).some(Boolean)) present.push(manager);
    }
    return present.length > 1 ? undefined : present[0] ?? 'npm';
}

/**
 * Discovery is local to the Node and never accepts a client-supplied command,
 * argv, environment, directory or script body. A package script still runs
 * repository-controlled code: deployment must sandbox execution separately.
 */
export async function discoverAutoScripts(root: string): Promise<Record<string, DevTask>> {
    // Existing installations retain their prior allowlist-only behaviour.
    if (process.env.ATLAS_NODE_AUTO_SCRIPTS !== '1') return {};
    const manifest = await readPackageManifest(root);
    if (!manifest) return {};
    const manager = await detectPackageManager(root, manifest);
    if (!manager || !manifest.scripts || typeof manifest.scripts !== 'object' || Array.isArray(manifest.scripts)) return {};
    const scripts = manifest.scripts as Record<string, unknown>;
    const tasks: Record<string, DevTask> = {};
    for (const name of allowedScripts) {
        if (!Object.hasOwn(scripts, name) || typeof scripts[name] !== 'string' || !scripts[name].trim()) continue;
        tasks[name] = {
            executable: manager, args: ['run', name],
            passEnvironment: [],
            timeoutMs: name === 'test' ? 600_000 : 120_000,
        };
    }
    return tasks;
}
