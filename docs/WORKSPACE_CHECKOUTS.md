# Logical Workspaces and Node-bound Checkouts (incremental migration)

## Model

A **logical Workspace** is a repository-level identity, independent of the
machine hosting its files. A **Checkout** is a specific directory bound to
one Node. A Git worktree is a special checkout associated with another checkout
through Git's common directory; two clones on different Nodes are **not** the
same Git worktree, even when both use the `main` branch.

```text
Portfolio Site  [logical_workspace.id, repository=affank1020/portfolio-site]
  MacBook       [legacy workspace.id, nodeId, rootPath, branch=main]
  Linux VPS     [legacy workspace.id, nodeId, rootPath, branch=main]
  Mac feature   [legacy workspace.id, nodeId, rootPath, branch=atlas/feature]
```

## Safe, incremental deployment

Migration `019_logical_workspaces.sql` creates logical identities and adds
`workspaces.logical_workspace_id`. It **does not** move, delete, rename or
deduplicate any checkout and **does not** alter existing Workspace IDs, Git
metadata, Node assignments, Project links, audit history or directory paths.

Each existing checkout initially receives its own logical identity. To group
existing Git checkouts, use the Workspaces page's **Recognise repositories**
action, or call `attach_checkout_repository` on each active checkout. The
Server asks the bound Node for a verified GitHub origin, then associates the
checkout with the single case-insensitive repository identity. Neither a
display name nor a path nor an untrusted caller-provided URL may determine
membership. Offline Nodes are deferred.

`list_logical_workspaces` returns the logical identities and their checkouts;
legacy `list_workspaces`, `get_workspace`, file, Git and football actions
continue to accept the existing node-bound Workspace IDs. New Atlas-managed
Git worktrees inherit the source checkout's logical identity; new authorised
GitHub clones join the matching logical repository immediately.

The added logical ID is stripped from transport messages to Nodes so remote
Node protocol v2 remains compatible with already connected Nodes.

When a verified source checkout is recognised, any existing Atlas-managed
feature worktrees that inherited its provisional `local` logical identity are
moved with it, in the same database transaction, including archived records.
A subsequent feature checkout inherits the now-recognised repository identity.
A pre-existing `git` group is never bulk-reassigned based on the origin of
one member.

`update_workspace` continues to rename an individual checkout. For a
`local` Workspace with exactly one **active** checkout, its logical
display name is also updated atomically, even if archived checkouts remain
in its history. Renaming one checkout in a group with multiple active
checkouts or in a `git` Workspace does not rename the repository-level
identity; explicit logical rename support will be added separately.

Repository recognition and managed Git worktree creation share a
transaction-scoped advisory lock on the source's original logical Workspace
ID, acquired **before** checkout row locks or Node-side filesystem creation.
This serializes recognition with both concurrent sibling recognition and
new feature checkout registration, preventing a foreign-key/checkout-row
deadlock that could otherwise strand an already-created worktree on disk.
If recognition moves the group first, a creation attempt with a stale
logical ID fails `CONFLICT` before touching the Node; retrying after
refreshing the checkout is safe. Recognition itself is also retryable
when another request has already moved its original logical group.

Managed feature retirement **requires** a GitHub PR merged for the exact
feature HEAD into the repository default branch, in addition to Node-side
cleanliness, index flag, process and provenance guards. GitHub inspection
failures or missing merged-PR evidence never trigger local checkout deletion.

## Limitations before a later cleanup

- Project links are still stored against legacy node-bound checkout IDs.
  Logical Workspace-level Project associations need a separate migration.
- Existing unverified clones remain separate until their Nodes are online and
  the explicit reconciliation is performed; no name-based fallback.
- Branch, dirty status and storage are per checkout, not per logical Workspace.
- Current MCP write operations still select `workspaceId` as the checkout ID.
  A future version may expose explicit `checkoutId` inputs while preserving
  compatibility.
- Logical Workspaces with no active checkouts are omitted from the default
  list. Empty provisional local identities may be removed by reconciliation;
  Git repository identities with only archived checkouts are retained.

Do not remove old checkout rows or force-delete directories during this
transition. Run a database backup before migration, verify old Workspace IDs
remain addressable, reconcile Portfolio Site on both Nodes, and check that
`list_logical_workspaces` shows a single Portfolio logical identity with both
checkout paths before releasing the updated UI to everyone.
