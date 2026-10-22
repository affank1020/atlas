import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { AtlasError } from '@atlas/protocol/errors';
import { permitted, verifyGitLayout, type WorkspaceFiles } from './files.js';

const execute = promisify(execFile);
const validBranch = (branch: string) => /^atlas\/[a-z0-9][a-z0-9/_-]{0,72}$/.test(branch) && !branch.includes('//') && !branch.endsWith('/');
async function run(root: string, args: string[], extras: Record<string, string> = {}, timeout = 10000) {
  const result = await execute('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', root, ...args], {
    timeout, maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', HOME: '/var/empty', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', ...extras },
  });
  return result.stdout.trim();
}
// Return only fixed, actionable messages. Git process output is untrusted and may
// contain tokens or HTTP headers, so never return it or interpolate it into errors.
export function classifyGitPushFailure(error: unknown): AtlasError {
  const failure = error as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown; signal?: unknown } | null;
  const output = [failure?.stderr, failure?.stdout]
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.slice(0, 32768)).join('\n');
  if (failure?.killed === true || failure?.code === 'ETIMEDOUT' || failure?.signal === 'SIGTERM')
    return new AtlasError('Git push timed out. Check Node connectivity and retry after verifying the remote branch.', 'GIT_PUSH_TIMEOUT');
  if (/workflow(s)? (?:permission|scope)|without .?workflows.? permission|refusing to allow .*workflow|\.github\/workflows/i.test(output))
    return new AtlasError('GitHub rejected a workflow-file update. Approve Workflows: read and write permission for the Atlas GitHub App installation.', 'GITHUB_WORKFLOWS_PERMISSION_REQUIRED');
  if (/non-fast-forward|fetch first|stale info|\[rejected\].*\(.*(?:fetch|behind|non-fast-forward)/i.test(output))
    return new AtlasError('GitHub rejected the push because the remote branch has diverged. Fetch and reconcile changes; Atlas will not force-push.', 'GIT_PUSH_NON_FAST_FORWARD');
  if (/protected branch|repository rule|rule violations|GH006|GH013/i.test(output))
    return new AtlasError('GitHub repository rules or branch protection rejected the push.', 'GIT_PUSH_PROTECTED');
  if (/authentication failed|permission denied|access denied|not authorized|write access .*not granted|HTTP (?:401|403)|requested URL returned error: (?:401|403)/i.test(output))
    return new AtlasError('GitHub rejected Git push authentication or authorization. Check the App installation and repository write access.', 'GIT_PUSH_AUTH_FAILED');
  if (/could not resolve host|failed to connect|couldn.t connect|connection (?:timed out|reset|refused)|network is unreachable|SSL connect|TLS handshake|requested URL returned error: 5\d\d|HTTP 5\d\d/i.test(output))
    return new AtlasError('Git push could not reach GitHub. Check connectivity or GitHub service status.', 'GIT_PUSH_NETWORK_FAILED');
  if (failure?.code === 'ENOENT' || failure?.code === 'EACCES' || failure?.code === 'EPERM')
    return new AtlasError('Git could not run on this Node. Check the Git executable and Node permissions.', 'GIT_PUSH_NODE_UNAVAILABLE');
  return new AtlasError('Git push failed. Check repository access, remote branch state, and Node connectivity.', 'GIT_PUSH_FAILED');
}

async function approvedGitRoot(root: string, legacyVariable: string) {
  // Existing exact opt-ins continue to work. A trusted development directory can
  // now be configured ONCE for many Git repositories, but is never implicit.
  const exact = (process.env[legacyVariable] || '').split(',').map(s => s.trim()).filter(Boolean);
  if (exact.includes(root)) return true;
  const parents = (process.env.ATLAS_GIT_TRUSTED_ROOTS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const parent of parents) {
    if (!path.isAbsolute(parent)) continue;
    try {
      const canonical = await realpath(parent);
      // Do not accept a configured symbolic-link alias as an approval root.
      if (canonical !== parent) continue;
      if (root === canonical || root.startsWith(canonical + path.sep)) return true;
    } catch { /* A missing approved root grants nothing. */ }
  }
  return false;
}
export async function gitWrite(root: string, files: WorkspaceFiles, operation: string, input: Record<string, any>) {
  await files.resolve(root, '');
  if (!await approvedGitRoot(root, 'ATLAS_GIT_WRITE_ROOTS'))
    throw new AtlasError('Git writes are not approved for this workspace.', 'CAPABILITY_UNAVAILABLE');
  // Reuse the read-only Git layout verifier: linked worktrees are allowed
  // only when their common checkout is also in an approved Node filesystem.
  await verifyGitLayout(root, files);
  const commonGitDir = await run(root, ['rev-parse', '--git-common-dir']);
  const common = path.isAbsolute(commonGitDir) ? commonGitDir : path.resolve(root, commonGitDir);
  if (path.basename(common) !== '.git' || await realpath(common) !== common ||
      !await approvedGitRoot(path.dirname(common), 'ATLAS_GIT_WRITE_ROOTS'))
    throw new AtlasError('Git worktree common directory is not an approved repository.', 'WORKSPACE_DENIED');
  if (await run(root, ['rev-parse', '--show-toplevel']) !== root)
    throw new AtlasError('Workspace is not the Git repository root.', 'WORKSPACE_DENIED');
  const branch = await run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (input.branch && !validBranch(input.branch)) throw new AtlasError('Invalid Git branch.', 'INVALID_REQUEST');
  // A clean main checkout may create/switch to an approved atlas/* branch.
  // Staging, committing and publishing still require an atlas/* checkout.
  if (operation === 'workspace_git_create_branch' || operation === 'workspace_git_switch_branch') {
    if (await run(root, ['status', '--porcelain'])) throw new AtlasError('Working tree is not clean.', 'CONFLICT');
    if (operation === 'workspace_git_create_branch') await run(root, ['switch', '-c', input.branch]);
    else await run(root, ['switch', input.branch]);
    return { branch: input.branch, head: await run(root, ['rev-parse', 'HEAD']) };
  }
  if (!validBranch(branch)) throw new AtlasError('Git writes require an atlas/* branch.', 'CONFLICT');
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
  if (operation === 'workspace_git_push_branch') {
    if (!await approvedGitRoot(root, 'ATLAS_GIT_REMOTE_ROOTS'))
      throw new AtlasError('Remote Git publishing is not approved on this Node root.', 'CAPABILITY_UNAVAILABLE');
    if (branch !== input.branch || await run(root, ['rev-parse', 'HEAD']) !== input.expectedHead)
      throw new AtlasError('Git branch or HEAD changed since inspection.', 'CONFLICT');
    if (await run(root, ['status', '--porcelain'])) throw new AtlasError('Working tree is not clean.', 'CONFLICT');
    // Inspect the literal origin rather than the possibly rewritten URL; macOS
    // checkouts often use SSH. The actual push still goes to GitHub over HTTPS
    // using the Server-brokered installation token, never the user's SSH key.
    const repository = input.repository;
    if (typeof repository !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository))
      throw new AtlasError('Invalid approved GitHub repository.', 'WORKSPACE_DENIED');
    let origin: string;
    try { origin = await run(root, ['config', '--local', '--get', 'remote.origin.url']); }
    catch { throw new AtlasError('Git origin is missing or cannot be read. Configure the approved repository remote.', 'GIT_REMOTE_INVALID'); }
    const allowedOrigins = [
      `https://github.com/${repository}`, `https://github.com/${repository}.git`,
      `git@github.com:${repository}`, `git@github.com:${repository}.git`,
      `ssh://git@github.com/${repository}`, `ssh://git@github.com/${repository}.git`,
    ];
    if (!allowedOrigins.includes(origin))
      throw new AtlasError('Git origin does not match approved GitHub repository.', 'GIT_REMOTE_MISMATCH');
    if (typeof input.githubToken !== 'string' || input.githubToken.length < 20)
      throw new AtlasError('Missing brokered GitHub credential.', 'CAPABILITY_UNAVAILABLE');
    const basic = Buffer.from(`x-access-token:${input.githubToken}`).toString('base64');
    // The short-lived token is supplied in child environment, not argv, Git config or a file.
    // Force Git to refuse redirects so the authenticated request cannot follow an arbitrary host.
    try {
      await run(root, ['-c', 'http.followRedirects=false', 'push', '--porcelain', '--',
        `https://github.com/${input.repository}.git`, `HEAD:refs/heads/${branch}`], {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      }, 45000);
    } catch (error) {
      throw classifyGitPushFailure(error);
    }
    return { repository: input.repository, branch, head: input.expectedHead, pushed: true };
  }
  throw new AtlasError('Unsupported Git operation.', 'INVALID_REQUEST');
}
