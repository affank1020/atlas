#!/usr/bin/env node
/**
 * Produce an installable Node-only bundle; never include owner configuration,
 * local credentials, development workspaces, or the Atlas Server/Web source.
 *
 * After extracting on a supported host:
 *   npm ci --omit=dev --ignore-scripts --workspace @atlas/node --workspace @atlas/protocol --include-workspace-root=false
 *   node apps/node/dist/platforms/desktop/main.js
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? join(repo, '.build/node-releases'));
const required = [
    'apps/node/package.json', 'apps/node/dist',
    'packages/protocol/package.json', 'packages/protocol/dist',
];
const version = JSON.parse(await readFile(join(repo, 'apps/node/package.json'), 'utf8')).version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/.test(version))
    throw new Error('Node package has no valid semver version.');
const commit = (process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' })).trim();
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected a complete source commit SHA.');
const changed = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();
if (changed && process.env.ATLAS_ALLOW_DIRTY_NODE_PACKAGE !== '1')
    throw new Error('Refusing to label a dirty checkout as an immutable Node release.');
const stage = await mkdtemp(join(tmpdir(), 'atlas-node-package-'));
try {
    for (const item of required) {
        const destination = join(stage, item);
        await mkdir(dirname(destination), { recursive: true });
        await cp(join(repo, item), destination, { recursive: true, force: false });
    }
    // Generate a Node-only npm workspace graph. The monorepo's root lockfile
    // also describes Server and Web, so copying it would leak unrelated
    // dependencies into the release and make npm ls report missing workspaces.
    const manifest = {
        name: 'atlas-node-release',
        version,
        private: true,
        type: 'module',
        workspaces: ['apps/node', 'packages/protocol'],
    };
    await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    execFileSync('npm', [
        'install', '--package-lock-only', '--omit=dev', '--ignore-scripts',
        '--no-audit', '--no-fund',
    ], { cwd: stage, stdio: 'pipe', timeout: 120_000 });
    const releaseLock = JSON.parse(await readFile(join(stage, 'package-lock.json'), 'utf8'));
    for (const excluded of [
        'apps/server', 'apps/web', 'packages/view-runtime',
        'node_modules/@atlas/server', 'node_modules/@atlas/web',
        'node_modules/handlebars',
    ]) {
        if (Object.hasOwn(releaseLock.packages ?? {}, excluded)) {
            throw new Error('Unexpected Server/Web package in Node release: ' + excluded);
        }
    }
    const release = {
        application: '@atlas/node',
        version,
        commit,
        protocol: 2,
        entrypoint: 'apps/node/dist/platforms/desktop/main.js',
        supportedHosts: ['darwin', 'linux'],
        nodeRuntime: '>=20',
        install: 'npm ci --omit=dev --ignore-scripts --workspace @atlas/node --workspace @atlas/protocol --include-workspace-root=false',
    };
    await writeFile(join(stage, 'atlas-node-release.json'), JSON.stringify(release, null, 2) + '\n');
    await mkdir(output, { recursive: true });
    const name = `atlas-node-v${version}-${commit.slice(0, 12)}.tar.gz`;
    const archive = join(output, name);
    execFileSync('tar', ['-C', stage, '-czf', archive, '.']);
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    await writeFile(archive + '.sha256', `${digest}  ${name}\n`);
    console.log(JSON.stringify({ archive, sha256: digest, version, commit }));
} finally {
    await rm(stage, { recursive: true, force: true });
}
