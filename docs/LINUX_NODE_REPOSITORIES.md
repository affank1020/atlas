# Phase 4: Linux repository bootstrap (initial public-repository pilot)

The first approved repository is `affank1020/portfolio-site` on its public `main` branch. This operator-run bootstrap creates `/srv/atlas/workspaces/portfolio-site`, independently of the production Atlas deployment.

On the VPS after reviewing the script:

```bash
sudo install -o root -g root -m 0755 linux-node-repo-bootstrap.sh /usr/local/sbin/atlas-node-repo-bootstrap
sudo -u atlas-node /usr/local/sbin/atlas-node-repo-bootstrap clone portfolio-site
sudo -u atlas-node /usr/local/sbin/atlas-node-repo-bootstrap status portfolio-site
```

The clone is shallow, HTTPS-only by fixed source, has no credential prompts, no submodules, no symlink entries, no hooks or LFS smudge, and is performed as `atlas-node` in an isolated staging directory. It creates `atlas/bootstrap` rather than working on main; the script refuses to overwrite an existing checkout. No generic Git write endpoint is exposed yet.

Register the resulting path against a **new Atlas Project** bound to the Linux Node through `create_workspace`, then verify `workspace_read_file` and `workspace_git_status`. Do not assign an existing project with a separate active workspace; one active workspace per project is enforced.

Next milestone: audited Git fetch, branch/worktree creation, commit and push using approved repository credentials, then a constrained Linux development-task sandbox. Do not give the Node Docker access or access to production deployment secrets.
