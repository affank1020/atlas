import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceFiles } from '../apps/node/src/capabilities/workspace-files/files.js';
import { listManagedWorktrees, createManagedWorktree, removeManagedWorktree, cloneManagedRepository } from '../apps/node/src/capabilities/workspace-files/git-managed.js';

const git = (root: string, ...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

test('managed worktrees are isolated, registered in Git, and retire without deleting their branch', async t => {
    const previous = process.env.ATLAS_GIT_TRUSTED_ROOTS;
    t.after(() => {
        if (previous === undefined) delete process.env.ATLAS_GIT_TRUSTED_ROOTS;
        else process.env.ATLAS_GIT_TRUSTED_ROOTS = previous;
    });
    const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atlas-managed-worktrees-')));
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    const source = path.join(parent, 'source');
    mkdirSync(source);
    process.env.ATLAS_GIT_TRUSTED_ROOTS = parent;
    const files = new WorkspaceFiles([parent]);

    git(source, 'init', '-b', 'main');
    git(source, 'config', 'user.name', 'Test');
    git(source, 'config', 'user.email', 'test@example.test');
    writeFileSync(path.join(source, 'README.md'), 'initial\n');
    writeFileSync(path.join(source, '.gitignore'), '*.cache\n');
    git(source, 'add', 'README.md', '.gitignore');
    git(source, 'commit', '-m', 'Initial');
    const originalHead = git(source, 'rev-parse', 'HEAD');
    // Worktrees must branch from HEAD, not silently include dirty changes.
    writeFileSync(path.join(source, 'README.md'), 'dirty source\n');

    const createdPath = path.join(parent, 'feature');
    await assert.rejects(
        createManagedWorktree(source, files, 'main', createdPath), /atlas/);
    await assert.rejects(
        createManagedWorktree(source, files, 'atlas/feature', path.join(realpathSync(os.tmpdir()), 'outside-feature')),
        /outside (?:the trusted Git roots|ATLAS_WORKSPACE_ROOTS)/);
    mkdirSync(path.join(parent, 'already-exists'));
    await assert.rejects(
        createManagedWorktree(source, files, 'atlas/feature', path.join(parent, 'already-exists')),
        /already exists/);

    const created = await createManagedWorktree(source, files, 'atlas/feature', createdPath);
    assert.equal(created.head, originalHead);
    assert.equal(git(createdPath, 'branch', '--show-current'), 'atlas/feature');
    assert.equal(git(createdPath, 'status', '--porcelain'), '');
    const visible = await listManagedWorktrees(source, files);
    assert.equal(visible.worktrees.length, 2);
    assert.ok(visible.worktrees.some(x => x.rootPath === createdPath && x.branch === 'atlas/feature'));

    writeFileSync(path.join(createdPath, 'untracked.txt'), 'keep me');
    await assert.rejects(removeManagedWorktree(source, files, createdPath, originalHead, 'atlas/feature'), /uncommitted, untracked/);
    rmSync(path.join(createdPath, 'untracked.txt'));
    writeFileSync(path.join(createdPath, 'build.cache'), 'ignored local data');
    assert.equal(git(createdPath, 'status', '--porcelain'), '');
    await assert.rejects(removeManagedWorktree(source, files, createdPath, originalHead, 'atlas/feature'), /ignored files/);
    rmSync(path.join(createdPath, 'build.cache'));

    // Git deliberately hides local edits for these index flags. Verify that
    // both cases fail closed even though porcelain wrongly reports clean.
    for (const [flag, clearFlag] of [
        ['--assume-unchanged', '--no-assume-unchanged'],
        ['--skip-worktree', '--no-skip-worktree'],
    ]) {
        const hiddenFile = path.join(createdPath, 'README.md');
        writeFileSync(hiddenFile, 'local modifications that must survive ' + flag + '\n');
        git(createdPath, 'update-index', flag, '--', 'README.md');
        try {
            assert.equal(git(createdPath, 'status', '--porcelain'), '');
            assert.match(git(createdPath, 'ls-files', '-v', '--', 'README.md'), /^[a-zS] /);
            await assert.rejects(
                removeManagedWorktree(source, files, createdPath, originalHead, 'atlas/feature'),
                /assume-unchanged or skip-worktree/);
            assert.equal(existsSync(createdPath), true, 'local checkout must survive ' + flag);
            assert.equal(git(createdPath, 'rev-parse', 'HEAD'), originalHead);
        } finally {
            git(createdPath, 'update-index', clearFlag, '--', 'README.md');
            writeFileSync(hiddenFile, 'initial\n');
        }
    }

    // A running program with its cwd in the checkout prevents local deletion.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], {
        cwd: createdPath, stdio: 'ignore',
    });
    try {
        await new Promise(resolve => setTimeout(resolve, 150));
        await assert.rejects(removeManagedWorktree(source, files, createdPath, originalHead, 'atlas/feature'),
            /(?:process is currently working inside|Cannot verify active worktree processes)/);
        assert.equal(existsSync(createdPath), true);
    } finally {
        await new Promise<void>(resolve => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once('exit', () => resolve());
            child.kill();
        });
    }
    await assert.rejects(removeManagedWorktree(source, files, createdPath, 'a'.repeat(40), 'atlas/feature'), /HEAD changed/);
    await assert.rejects(removeManagedWorktree(source, files, createdPath, originalHead, 'atlas/different'), /branch changed/);
    await assert.rejects(removeManagedWorktree(source, files, source, originalHead, 'atlas/feature'), /parent checkout/);
    const removed = await removeManagedWorktree(source, files, createdPath, originalHead, 'atlas/feature');
    assert.equal(removed.preservedBranch, 'atlas/feature');
    assert.ok(removed.estimatedReclaimedBytes > 0);
    assert.equal(existsSync(createdPath), false);
    assert.equal(git(source, 'rev-parse', 'refs/heads/atlas/feature'), originalHead);
    assert.equal((await listManagedWorktrees(source, files)).worktrees.length, 1);
});

test('repository provisioning rejects untrusted roots, existing destinations and missing GitHub credentials', async t => {
    const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atlas-repository-clone-')));
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    const old = process.env.ATLAS_GIT_TRUSTED_ROOTS;
    t.after(() => {
        if (old === undefined) delete process.env.ATLAS_GIT_TRUSTED_ROOTS;
        else process.env.ATLAS_GIT_TRUSTED_ROOTS = old;
    });
    const files = new WorkspaceFiles([parent]);
    const credential = 'test-token-not-a-real-GitHub-token';
    process.env.ATLAS_GIT_TRUSTED_ROOTS = '';
    await assert.rejects(
        cloneManagedRepository(parent, files, 'affank1020/atlas', 'clone', credential), /dedicated trusted Git development root/);
    process.env.ATLAS_GIT_TRUSTED_ROOTS = parent;
    await assert.rejects(
        cloneManagedRepository(parent, files, 'affank1020/atlas', '../escape', credential),
        /Invalid GitHub repository or destination/);
    await assert.rejects(
        cloneManagedRepository(parent, files, 'affank1020/atlas', 'clone', ''),
        /Missing brokered GitHub credential/);
    mkdirSync(path.join(parent, 'existing'));
    await assert.rejects(
        cloneManagedRepository(parent, files, 'affank1020/atlas', 'existing', credential),
        /destination already exists/);
});
