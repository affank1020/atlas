import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

type RuntimePlatform = NodeJS.Platform;

/** Preserve the existing macOS UI location; use XDG state paths on Linux. */
export function nodeStatusPath(
    platform: RuntimePlatform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home = homedir(),
): string {
    if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Atlas', 'node-status.json');
    if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Atlas', 'node-status.json');
    const base = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)
        ? env.XDG_STATE_HOME : join(home, '.local', 'state');
    return join(base, 'atlas', 'node-status.json');
}

/** This file has the same relative location in both TS source and built JS. */
const nodePackageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function installedNodeVersion(packageDir = nodePackageDir): string | undefined {
    try {
        const pkg: unknown = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
        if (!pkg || typeof pkg !== 'object' || !('version' in pkg)) return undefined;
        const version = (pkg as { version?: unknown }).version;
        if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) return undefined;
        try {
            const info: unknown = JSON.parse(readFileSync(resolve(packageDir, '../..', 'atlas-node-release.json'), 'utf8'));
            if (info && typeof info === 'object') {
                const release = info as { application?: unknown; version?: unknown; commit?: unknown };
                if (release.application === '@atlas/node' && release.version === version &&
                    typeof release.commit === 'string' && /^[a-f0-9]{40}$/.test(release.commit)) {
                    return `${version}+${release.commit.slice(0, 12)}`;
                }
            }
        } catch { /* A developer checkout is not a packaged Node installation. */ }
        return version;
    } catch { return undefined; }
}
