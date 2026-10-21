import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/linux-node-trusted-stage.sh');
const sourceSha = '1234567890abcdef1234567890abcdef12345678';
const name = 'atlas-node-v2.0.0-' + sourceSha.slice(0, 12) + '.tar.gz';

function fixture(ghVersion = '2.102.0') {
    const root = mkdtempSync(join(tmpdir(), 'atlas-node-trusted-stage-'));
    const bundle = join(root, 'bundle');
    const bin = join(root, 'bin');
    mkdirSync(bundle); mkdirSync(bin);
    for (const part of ['apps/node', 'packages/protocol']) mkdirSync(join(bundle, part), { recursive: true });
    for (const path of ['package.json', 'package-lock.json', 'apps/node/package.json', 'packages/protocol/package.json']) {
        writeFileSync(join(bundle, path), '{}');
    }
    writeFileSync(join(bundle, 'atlas-node-release.json'), JSON.stringify({
        application: '@atlas/node', version: '2.0.0', commit: sourceSha,
        protocol: 2, entrypoint: 'apps/node/dist/platforms/desktop/main.js',
    }));
    const archive = join(root, name);
    execFileSync('tar', ['-czf', archive, '-C', bundle, '.']);
    const checksum = archive + '.sha256';
    function writeChecksum() {
        const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
        writeFileSync(checksum, digest + '  ' + name + '\n');
    }
    writeChecksum();
    const trace = join(root, 'gh-args');
    const gh = join(bin, 'gh');
    // Stubbed verifier tests strict arguments and rejection propagation.
    // Real cryptographic verification is delegated to patched GitHub CLI.
    writeFileSync(gh, [
        '#!/usr/bin/env bash',
        'if [[ "$1" == "--version" ]]; then echo "gh version $ATLAS_GH_TEST_VERSION"; exit 0; fi',
        'printf "%s\\n" "$@" > "$ATLAS_GH_TEST_TRACE"',
        'if [[ "$1" == attestation && "$2" == verify ]]; then exit "${ATLAS_GH_TEST_EXIT:-0}"; fi',
        'exit 2',
    ].join('\n') + '\n');
    chmodSync(gh, 0o755);
    function run(extra: Record<string, string> = {}, selectedArchive = archive) {
        return spawnSync('bash', [script, 'verify', selectedArchive, checksum], {
            encoding: 'utf8',
            env: { ...process.env, PATH: bin + ':' + process.env.PATH,
                ATLAS_GH_TEST_TRACE: trace, ATLAS_GH_TEST_VERSION: ghVersion, ...extra },
        });
    }
    return { root, bundle, archive, checksum, trace, run, writeChecksum };
}

test('requires exact repository, main, workflow certificate and attested source digest', () => {
    const f = fixture();
    try {
        const res = f.run();
        assert.equal(res.status, 0, res.stderr);
        const args = readFileSync(f.trace, 'utf8').split('\n');
        for (const item of [
            'attestation', 'verify', '--repo', 'affank1020/atlas',
            '--cert-identity',
            'https://github.com/affank1020/atlas/.github/workflows/node-package.yml@refs/heads/main',
            '--source-ref', 'refs/heads/main',
            '--source-digest', sourceSha,
            '--predicate-type', 'https://slsa.dev/provenance/v1',
        ]) assert.ok(args.includes(item), 'Missing required provenance option: ' + item);
        assert.match(res.stdout, /Verified GitHub build provenance/);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('patched GitHub CLI is mandatory; vulnerable 2.101.0 is refused before verification', () => {
    for (const version of ['2.101.0', '2.96.0', '1.99.0']) {
        const f = fixture(version);
        try {
            const res = f.run();
            assert.notEqual(res.status, 0);
            assert.match(res.stderr, /2\.102\.0\+/);
            assert.throws(() => readFileSync(f.trace, 'utf8'));
        } finally { rmSync(f.root, { recursive: true, force: true }); }
    }
});

test('bad checksum cannot be redeemed by an attestation', () => {
    const f = fixture();
    try {
        writeFileSync(f.checksum, '0'.repeat(64) + '  ' + name + '\n');
        const res = f.run();
        assert.notEqual(res.status, 0);
        assert.match(res.stderr, /SHA-256 mismatch|verification failed/);
        assert.throws(() => readFileSync(f.trace, 'utf8'));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejected or unavailable attestation never reports a verified archive', () => {
    const f = fixture();
    try {
        const res = f.run({ ATLAS_GH_TEST_EXIT: '1' });
        assert.notEqual(res.status, 0);
        assert.match(res.stderr, /Build-provenance verification failed/);
        assert.doesNotMatch(res.stdout, /Verified GitHub build provenance/);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a prerelease filename cannot enter the stable staging path', () => {
    const f = fixture();
    try {
        const res = f.run({}, f.archive.replace('.tar.gz', '-rc.1.tar.gz'));
        assert.notEqual(res.status, 0);
        assert.throws(() => readFileSync(f.trace, 'utf8'));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('installer does not expose update control or restart active services', () => {
    const source = readFileSync(script, 'utf8');
    assert.match(source, /linux-node-release\.sh" install/);
    assert.doesNotMatch(source, /systemctl|linux-node-lifecycle\.sh|sudo\s/);
    assert.match(source, /mktemp -d "\$root\/\.signed-stage/);
    assert.match(source, /verify_archive "\$stage\/\$archive_name"/);
});
