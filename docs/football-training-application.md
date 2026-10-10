# Football Training — Atlas Application V2

The **Football Training** Application is attached to the existing AI Football FYP
Project (`ce09dbe0-0755-4bd8-9376-e4a3152d59f7`). It launches from
`Projects → AI Football → Applications` in a separate browser tab.

## Architecture

Atlas Web (React) → Atlas Server (application registry and authenticated HTTP/MCP)
→ AI Football Workspace and NodeRouter (project ownership and capability check)
→ the enrolled Mac Node (`football.training` capability)
→ `python3 football_driver.py` from the bound Unity Workspace root.

No Python or Unity binaries run on the hosted Server. The Node enforces a fixed
command vocabulary, bounded arguments, a non-symlink local driver, and
`shell: false`. It does not accept arbitrary scripts or paths.

Available Atlas application actions:
- `football_list_drills`, `football_list_jobs`, `football_get_job_logs`
- `football_launch_training`, `football_get_launch_status`, `football_stop_training`
- `football_list_policies`, `football_index_policy`, `football_plan_evaluation`
- `football_list_evaluations`, `football_run_evaluation`, `football_get_evaluation_status`
- `football_list_viewers`, `football_watch_live`, `football_open_policy_viewer`, `football_get_viewer_launch_status`

Launch is **asynchronous** because headless training may first need to build a
standalone Unity runner. The operation returns an accepted *launch ticket*, not
a successful trainer result. Poll `football_get_launch_status`, refresh jobs and
inspect the Python log. The Mac writes launch receipts under the ignored
`training-driver-runs/atlas-launches` directory. A running job is determined
by the existing Python orchestrator, not the UI. Launch receipts are diagnostics
rather than a durable scheduler/queue; a Node restart can leave outstanding
runs to be reconciled via `training-jobs`.

Stopping sends the driver’s graceful SIGINT request and **does not** assume
the checkpoint completed. The Evaluation screen can launch actual seeded Unity
inference runs and reads measured results from `evaluation-results`; its
separate dry-run plan does not produce metrics. Evaluation receipts distinguish
a launch from a completed evaluation. Bounded trainer logs are refreshed
manually.

The Watch screen starts a local graphical Unity viewer, either loading an
indexed ONNX policy (`watch`) or observing the live telemetry of a running
headless PPO job (`watch-live`). A viewer is launched asynchronously and its
status is checked through a receipt and `viewer-sessions`. **The viewer opens
on the Mac, not inside the browser**, and does not stop or affect PPO training.
Older runs without telemetry cannot be watched live.

Navigation is split into Overview, Drills, Train, Runs, Evaluation, Policies,
and Watch. Runs default to Active, with Last 7 days, Archive (older completed
or stopped), and All filters, plus text/drill search. These are presentation
filters: no experiment files are deleted or modified.

## Operating and deployment

Both Atlas Server and the compiled **Mac Node** must be updated and restarted
for the new capability. Update/reconnect the node after deploying the Server,
and confirm the AI Football Workspace remains bound to the Mac. Do not run
training against the development source until the Unity trainer's M3.7 smoke
run has been verified. The AI Football driver is still uncommitted in the FYP
repository as of this implementation; Atlas only invokes it, it does not
copy or modify the driver source.

## Tests

`npm test` runs server, protocol, registry and web tests. Use the isolated
Docker-backed PostgreSQL container specified by `infra/docker-compose.yml`
for integration tests.
