# Phase 4.2: Local Git write operations

Workspace Git mutations now use the same authenticated transport and durable audit-intent path as file writes.

Opt in to local Git writes by configuring `ATLAS_GIT_WRITE_ROOTS` on the Node process, as a comma-separated list of exact, canonical approved Workspace roots. Default is **no Git writes enabled**. On the VPS, include only `/srv/atlas/workspaces/portfolio-site` after deploying a reviewed release. Do not include deployment directories.

Operations:
- `workspace_git_create_branch`: create a new local `atlas/*` branch from another `atlas/*` branch, clean tree required.
- `workspace_git_switch_branch`: switch between local `atlas/*` branches, clean tree required.
- `workspace_git_stage`: explicitly select up to 40 safe readable files, each with its inspected SHA-256. No wildcard or add-all.
- `workspace_git_commit`: only commit the enumerated paths if staged file set and Git index tree match the approved request.

Operations run via fixed Git argv without the user's global Git config, interactive prompts or repository hooks. Worktree symlinks, protected paths and non-repository roots are disallowed. No Git push, forced update, remote authentication, general shell tool or Linux build execution is enabled.

Future PR: add credential-brokered pushes and PR creation with stricter repository-level allowlisting and remote tracking, then separately deploy/run sandboxed Linux tasks.
