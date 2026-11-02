import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, mkdir, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WorkspaceFiles } from '../apps/node/src/capabilities/workspace-files/files.js';
import { piReadOperations } from '../apps/node/src/capabilities/pi/permissions.js';
import { PiWorkerSupervisor } from '../apps/node/src/capabilities/pi/supervisor.js';
import type { Workspace } from '@atlas/protocol/workspace';
import { piStartSchema, type PiStart, type PiApproval } from '@atlas/protocol/pi-worker';
const exec = promisify(execFile);
async function fixture(t: any) {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'atlas-pi-')));
    const previousTrusted = process.env.ATLAS_GIT_TRUSTED_ROOTS;
    process.env.ATLAS_GIT_TRUSTED_ROOTS = root;
    t.after(() => { if (previousTrusted === undefined) delete process.env.ATLAS_GIT_TRUSTED_ROOTS; else process.env.ATLAS_GIT_TRUSTED_ROOTS = previousTrusted; });
    const base = path.join(root, 'base'), checkout = path.join(root, 'worker');
    await mkdir(base);
    const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', base, ...args],
        { env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })).stdout.trim();
    await git('init', '-b', 'main');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init');
    const head = await git('rev-parse', 'HEAD');
    await git('worktree', 'add', '-b', 'atlas/pi-test', checkout);
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = { id: randomUUID(), nodeId: randomUUID(), rootPath: checkout, status: 'active' } as Workspace;
    const request: PiStart = { runId: randomUUID(), workspaceId: workspace.id, expectedHead: head,
        expectedBranch: 'atlas/pi-test', prompt: 'Read README.md', permission: 'read-only', timeoutMs: 3000 };
    const approval: PiApproval = { runId: request.runId, workspaceId: workspace.id, nodeId: workspace.nodeId,
        rootPath: checkout, head, branch: request.expectedBranch,
        promptSha256: createHash('sha256').update(request.prompt).digest('hex'), timeoutMs: request.timeoutMs,
        expiresAt: new Date(Date.now() + 60_000).toISOString() };
    return { root, base, checkout, workspace, request, approval, git, files: new WorkspaceFiles([root]) };
}
const script = fileURLToPath(new URL('./fixtures/pi-process.cjs', import.meta.url));
function service(f: Awaited<ReturnType<typeof fixture>>, mode: string, grant = f.approval) {
    return new PiWorkerSupervisor(f.workspace.nodeId, f.files, [grant], { platform: 'darwin', lockDirectory: path.join(f.root, 'pi.lock'),
        launch: cwd => spawn(process.execPath, [script, mode], { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
            env: { PATH: '/usr/bin:/bin' } }) });
}
async function finished(s: PiWorkerSupervisor, w: Workspace, id: string) {
    const end = Date.now() + 6000;
    while (!s.get(w, id).finishedAt && Date.now() < end) await new Promise(r => setTimeout(r, 20));
    const receipt = s.get(w, id); assert.ok(receipt.finishedAt, 'run must terminate within bound'); return receipt;
}
test('strict contract excludes writes, shell, environment, executable and unsafe branches', async t => {
    const f = await fixture(t);
    for (const expectedBranch of ['main','atlas/a//b','atlas/a/','other/feature'])
        assert.equal(piStartSchema.safeParse({ ...f.request, expectedBranch }).success, false);
    for (const extra of [{ env: { NODE_OPTIONS: '--inspect' } }, { executable: '/bin/sh' }, { permission: 'write' }])
        assert.equal(piStartSchema.safeParse({ ...f.request, ...extra }).success, false);
});
test('verified linked worktree completes only on Pi result AND exit, with bounded cursor events', async t => {
    const f = await fixture(t), s = service(f, 'events'); t.after(() => s.close());
    await s.start(f.workspace, f.request);
    assert.equal((await finished(s, f.workspace, f.request.runId)).state, 'completed');
    const page = s.events(f.workspace, f.request.runId);
    assert.equal(page.events.length, 256); assert.equal(page.truncated, true);
    assert.equal(page.events.at(-1)?.type, 'terminal');
    assert.deepEqual(s.events(f.workspace, f.request.runId, page.lastCursor).events, []);
    assert.throws(() => s.get({ ...f.workspace, nodeId: randomUUID() }, f.request.runId));
    await assert.rejects(s.start(f.workspace, f.request));
    const restarted = service(f, 'events');
    assert.throws(() => restarted.get(f.workspace, f.request.runId)); await restarted.close();
});
test('native read operations deny escapes, secrets, metadata, symlinks, hard links and writes', async t => {
    const f = await fixture(t), ops = piReadOperations(f.checkout);
    await writeFile(path.join(f.checkout, 'README.md'), 'evidence');
    await writeFile(path.join(f.root, 'outside'), 'secret');
    await writeFile(path.join(f.checkout, '.env'), 'SECRET=value');
    await symlink(path.join(f.root, 'outside'), path.join(f.checkout, 'sym'));
    await link(path.join(f.root, 'outside'), path.join(f.checkout, 'hard'));
    assert.equal((await ops.readFile(path.join(f.checkout, 'README.md'))).toString(), 'evidence');
    for (const p of ['../outside', '.env', '.git', 'sym', 'hard'])
        await assert.rejects(ops.readFile(path.resolve(f.checkout, p)));
    assert.deepEqual(Object.keys(ops).sort(), ['access','detectImageMimeType','readFile']);
});
test('admission rejects expired approval, changed prompt, placement, base checkout and HEAD', async t => {
    const f = await fixture(t);
    for (const mutate of [
        (x: typeof f) => ({ ...x.approval, expiresAt: 'invalid' }),
        (x: typeof f) => ({ ...x.approval, nodeId: randomUUID() }),
        (x: typeof f) => ({ ...x.approval, promptSha256: '0'.repeat(64) }),
        (x: typeof f) => ({ ...x.approval, rootPath: x.base }),
        (x: typeof f) => ({ ...x.approval, timeoutMs: 100 }),
    ]) {
        const s = service(f, 'hang', mutate(f));
        await assert.rejects(s.start(f.workspace, f.request)); await s.close();
    }
    const s = service(f, 'hang'); t.after(() => s.close());
    await assert.rejects(s.start({ ...f.workspace, rootPath: f.base }, f.request));
    await assert.rejects(s.start({ ...f.workspace, nodeId: randomUUID() }, f.request));
    await assert.rejects(s.start(f.workspace, { ...f.request, expectedHead: '0'.repeat(40) }));
    await exec('/usr/bin/git', ['-C', f.checkout, 'checkout', '--detach']);
    await assert.rejects(s.start(f.workspace, f.request));
});
for (const [mode, state, reason] of [
    ['crash','incomplete','unexpected_exit_or_result'], ['early','incomplete','unexpected_exit_or_result'],
    ['eof','failed','unexpected_exit_or_result'], ['malformed','failed','invalid_protocol'],
    ['flood','failed','output_limit'], ['model-error','failed','unexpected_exit_or_result'],
] as const) test('process failure: ' + mode, async t => {
    const f = await fixture(t), s = service(f, mode); t.after(() => s.close());
    await s.start(f.workspace, f.request);
    const receipt = await finished(s, f.workspace, f.request.runId);
    assert.equal(receipt.state, state); assert.equal(receipt.reason, reason);
    assert.equal(JSON.stringify(s.events(f.workspace, f.request.runId)).includes('private raw diagnostic'), false);
});
test('cancellation escalates SIGTERM-resistant group; prevents concurrent admission and closes runtime', async t => {
    const f = await fixture(t), s = service(f, 'hang'); t.after(() => s.close());
    await s.start(f.workspace, f.request);
    await assert.rejects(s.start(f.workspace, { ...f.request, runId: randomUUID() }));
    while (s.get(f.workspace, f.request.runId).state === 'starting') await new Promise(r => setTimeout(r, 10));
    s.cancel(f.workspace, f.request.runId);
    const receipt = await finished(s, f.workspace, f.request.runId);
    assert.equal(receipt.state, 'cancelled'); assert.equal(receipt.signal, 'SIGKILL');
    assert.throws(() => process.kill(receipt.pid!, 0));
    await s.close(); await assert.rejects(s.start(f.workspace, f.request));
});
test('deadline is terminal after actual process exit; shutdown waits for owned child', async t => {
    const f = await fixture(t); f.request.timeoutMs = f.approval.timeoutMs = 150;
    const s = service(f, 'hang'); t.after(() => s.close());
    await s.start(f.workspace, f.request);
    assert.equal((await finished(s, f.workspace, f.request.runId)).state, 'timed_out');
    const f2 = await fixture(t), s2 = service(f2, 'hang');
    await s2.start(f2.workspace, f2.request); await s2.close();
    assert.equal(s2.get(f2.workspace, f2.request.runId).state, 'cancelled');
});
test('spawn errors and unsupported platforms fail closed', async t => {
    const f = await fixture(t);
    const s = new PiWorkerSupervisor(f.workspace.nodeId, f.files, [f.approval], {
        platform: 'darwin', lockDirectory: path.join(f.root, 'pi.lock'), launch: () => spawn('/nonexistent-atlas-pi', [], { detached: true, stdio: ['pipe','pipe','pipe'] }) });
    await s.start(f.workspace, f.request);
    assert.equal((await finished(s, f.workspace, f.request.runId)).state, 'failed'); await s.close();
    const linux = new PiWorkerSupervisor(f.workspace.nodeId, f.files, [f.approval], { platform: 'linux' });
    await assert.rejects(linux.start(f.workspace, f.request)); await linux.close();
});
test('missing grants, trusted-root violations, changed Git identity and primary checkouts are rejected before launch', async t => {
    const f = await fixture(t);
    const absent = new PiWorkerSupervisor(f.workspace.nodeId, f.files, [], { platform: 'darwin' });
    await assert.rejects(absent.start(f.workspace, f.request)); await absent.close();
    const s = service(f, 'hang'); t.after(() => s.close());
    const oldTrusted = process.env.ATLAS_GIT_TRUSTED_ROOTS;
    delete process.env.ATLAS_GIT_TRUSTED_ROOTS;
    await assert.rejects(s.start(f.workspace, f.request));
    process.env.ATLAS_GIT_TRUSTED_ROOTS = oldTrusted;
    await exec('/usr/bin/git', ['-C', f.checkout, 'checkout', '-b', 'atlas/changed']);
    await assert.rejects(s.start(f.workspace, f.request));
    const baseWorkspace = { ...f.workspace, rootPath: f.base };
    await f.git('checkout', '-b', 'atlas/primary');
    const baseGrant = { ...f.approval, rootPath: f.base, branch: 'atlas/primary' };
    const base = service(f, 'hang', baseGrant);
    await assert.rejects(base.start(baseWorkspace, { ...f.request, expectedBranch: 'atlas/primary' }));
    await base.close();
});
test('cross-process lock blocks a second supervisor and uncertain restart without stealing it', async t => {
    const f = await fixture(t), first = service(f, 'hang'), second = service(f, 'hang');
    t.after(() => first.close()); t.after(() => second.close());
    await first.start(f.workspace, f.request);
    await assert.rejects(second.start(f.workspace, f.request));
    await first.close();
    // A leftover lock has no implicit recovery authority, even without an in-memory run.
    await mkdir(path.join(f.root, 'pi.lock'));
    await assert.rejects(second.start(f.workspace, f.request));
    await rm(path.join(f.root, 'pi.lock'), { recursive: true });
});
