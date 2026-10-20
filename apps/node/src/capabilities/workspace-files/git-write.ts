import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AtlasError } from '@atlas/protocol/errors';
import { permitted, type WorkspaceFiles } from './files.js';

const execute = promisify(execFile);
const validBranch = (branch: string) => /^atlas\/[a-z0-9][a-z0-9/_-]{0,72}$/.test(branch) && !branch.includes('//') && !branch.endsWith('/');
async function run(root: string, args: string[]) {
  const result = await execute('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', root, ...args], {
    timeout: 10000, maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', HOME: '/var/empty', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  });
  return result.stdout.trim();
}
export async function gitWrite(root: string, files: WorkspaceFiles, operation: string, input: Record<string, any>) {
  await files.resolve(root, '');
  const approved = (process.env.ATLAS_GIT_WRITE_ROOTS || '').split(',').map(s => s.trim());
  if (!approved.includes(root)) throw new AtlasError('Git writes are not approved for this workspace.', 'CAPABILITY_UNAVAILABLE');
  const meta = await lstat(path.join(root, '.git'));
  if (!meta.isDirectory() || meta.isSymbolicLink() || await realpath(path.join(root, '.git')) !== path.join(root, '.git'))
    throw new AtlasError('Unsupported Git repository layout.', 'WORKSPACE_DENIED');
  if (await run(root, ['rev-parse', '--show-toplevel']) !== root)
    throw new AtlasError('Workspace is not the Git repository root.', 'WORKSPACE_DENIED');
  const branch = await run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!validBranch(branch)) throw new AtlasError('Git writes require an atlas/* branch.', 'CONFLICT');
  if (input.branch && !validBranch(input.branch)) throw new AtlasError('Invalid Git branch.', 'INVALID_REQUEST');
  if (operation === 'workspace_git_create_branch' || operation === 'workspace_git_switch_branch') {
    if (await run(root, ['status', '--porcelain'])) throw new AtlasError('Working tree is not clean.', 'CONFLICT');
    if (operation === 'workspace_git_create_branch') await run(root, ['switch', '-c', input.branch]);
    else await run(root, ['switch', input.branch]);
    return { branch: input.branch, head: await run(root, ['rev-parse', 'HEAD']) };
  }
  if (operation === 'workspace_git_stage') {
    const selected = input.files as { path: string, expectedSha256: string }[];
    if (new Set(selected.map(f => f.path)).size !== selected.length) throw new AtlasError('Duplicate Git paths.', 'INVALID_REQUEST');
    for (const item of selected) {
      if (!permitted(item.path)) throw new AtlasError('Protected Git path.', 'WORKSPACE_DENIED');
      if ((await files.read(root, item.path)).sha256 !== item.expectedSha256)
        throw new AtlasError('File changed since inspection.', 'CONFLICT');
    }
    await run(root, ['add', '--', ...selected.map(f => ':(literal)' + f.path)]);
    return { branch, indexTree: await run(root, ['write-tree']), stagedFiles: selected.map(f => f.path) };
  }
  if (operation === 'workspace_git_commit') {
    if (branch !== input.branch || await run(root, ['write-tree']) !== input.expectedTree)
      throw new AtlasError('Branch or staged tree changed.', 'CONFLICT');
    const staged = (await run(root, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean).sort();
    if (JSON.stringify(staged) !== JSON.stringify([...input.files].sort()) || staged.some(p => !permitted(p)))
      throw new AtlasError('Unexpected staged paths.', 'CONFLICT');
    await run(root, ['-c', 'user.name=Atlas Node', '-c', 'user.email=atlas-node@users.noreply.github.com',
      'commit', '--no-gpg-sign', '-m', input.message]);
    return { branch, head: await run(root, ['rev-parse', 'HEAD']) };
  }
  throw new AtlasError('Unsupported Git operation.', 'INVALID_REQUEST');
}
