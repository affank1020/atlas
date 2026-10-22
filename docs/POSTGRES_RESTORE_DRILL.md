# Isolated PostgreSQL restore drill (manual, no production writes)

**Purpose:** Prove that a **specific** age-encrypted PostgreSQL snapshot
can be restored and queried in a short-lived PostgreSQL 16 instance.
This complements [manual encrypted snapshots](POSTGRES_BACKUP.md). It does
**not** create backups, upload offsite, restore Cloudflare R2 objects, or
prove an application-consistent recovery point.

## Prerequisites and strict isolation

- Use a **separate trusted Linux recovery host** with Node.js 20+, Docker,
  `age`, `sha256sum` and sufficient RAM (2 GiB container limit; PGDATA
  tmpfs capped at 1536 MiB). **Do not run the drill on the live VPS.**
  The script pins Docker to the recovery host's local
  `unix:///var/run/docker.sock` socket regardless of the default context.
  It refuses `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG` and Docker
  TLS environment overrides. Rootless/custom-socket Docker hosts are **not**
  yet supported; do not weaken the guard to accommodate them.
- On the physically separate recovery host, verify its identity and copy the
  printed **daemon ID only** into the local operator environment:
  ```bash
  docker --host unix:///var/run/docker.sock info --format '{{.ID}}'
  export ATLAS_RECOVERY_DOCKER_ID='PASTE_VERIFIED_RECOVERY_DAEMON_ID'
  ```
  **Never reuse the production daemon ID.** The script re-reads the ID from
  the pinned socket and rejects missing or mismatched approval before it
  starts a container or decrypts data. A daemon ID is not a cryptographic
  remote-attestation guarantee: verify host ownership, the physical machine
  and socket forwarding settings independently.
- Securely copy the encrypted `*.dump.age` and matching `*.dump.age.json`
  manifest from the backup host. Both must be regular, operator-owned 0600
  files, never symlinks. The script checks size and SHA-256, but a writable
  manifest is not a digital signature or proof of independent custody.
- Retrieve the private age identity from **offline key custody**, separately
  from production, as a private 0600 file. Never commit the private key,
  upload it into GitHub Actions, or store it on the production VPS.
- Copy `scripts/postgres-restore-drill.sh` from the reviewed Atlas revision
  onto this recovery host.

## Default dry run (no decryption or Docker)

```bash
bash scripts/postgres-restore-drill.sh \
  --archive=/absolute/private/path/atlas-...dump.age
```

This verifies manifest schema, size, checksum, ownership and private
permissions. It creates no container and prints `restore_verified=false`.

## Explicit, one-time isolated restoration

```bash
bash scripts/postgres-restore-drill.sh \
  --archive=/absolute/private/path/atlas-...dump.age \
  --identity=/absolute/private/path/age-identity.txt \
  --apply --confirm=ISOLATED_PG_RESTORE
```

This command is designed to run **only against the explicitly approved
local recovery daemon**, and never supplies any live Atlas database URL. It
creates a uniquely named disposable `postgres:16-alpine` container with
**no network**, **no published ports**, **no bind mounts or anonymous Docker
volumes**, fixed CPU/memory limits and a fresh `atlas_recovery` database.

The official PostgreSQL 16 image declares a `VOLUME` for its data directory.
The drill deliberately replaces it with a **1536 MiB tmpfs mount** and checks
the actual container inspection result before decryption. Thus the recovered
database is held in temporary, memory-backed storage on the trusted recovery
host; **the recovery host's swap configuration may still write tmpfs pages
to disk**. The JSON report therefore guarantees
`noHostBackedDatabaseVolume: true` rather than claiming no mounts exist.
Local PostgreSQL trust authentication is permitted only within the
networkless container.

It streams `age --decrypt` directly to pinned-daemon
`docker exec -i pg_restore` (using
`--single-transaction --exit-on-error --no-owner --no-acl`), never writing a
plaintext host dump. After restoring it queries `public.projects`,
`public.stores` and `public.records`, requiring a nonempty project catalog,
and checks the ciphertext SHA-256 again. **It removes the temporary
container before printing a successful JSON report.**

A failure does not print raw decrypted records or raw database diagnostics.
The script attempts to remove only the uniquely named drill container; if
cleanup fails, investigate and remove that container manually. It also
refuses `--apply` from a working directory containing
`infra/production.env`. The pinned-socket and approved-daemon-ID checks
are safeguards, **not** substitutes for physically separate recovery
infrastructure and operator verification of the host.

Record the ciphertext SHA-256, snapshot creation time, drill time, restored
database identity and outcome in the recovery runbook. A successful drill
proves only that this **one DB snapshot** was restorable and passed minimal
schema/data checks; it does not verify live Atlas boot, Node credentials,
R2 data, Docker secrets, application migrations or any RTO/RPO promise.

## Next operational recovery steps

1. Provision an independently administered Cloudflare R2 recovery bucket
   with separate credentials, no public access and retention protections.
   Use the existing append-only Atlas Files seeder and read-only verifier.
2. Store the encrypted database artifact **and manifest offsite**, with
   create-only uploads and destination checksum checks. This PR does not
   implement offsite publication.
3. Perform the restore drill again using the **offsite copy**, then test
   restoring R2 Files objects and the full Atlas service configuration,
   including an application-consistent DB/object capture boundary.
4. Only after real recovery validation consider automatic scheduling,
   failure alerts, retention pruning and measurable RTO/RPO objectives.
