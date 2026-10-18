# Atlas Portfolio media — Cloudflare R2

Atlas serves Portfolio media through `/api/media/{id}/{original|preview|thumbnail}` and retains existing PostgreSQL metadata, publishing and image-variant generation. With all four `ATLAS_R2_*` variables set, **new uploads go to R2**. The R2 bucket remains private; Atlas signs S3 requests on the server. Without the variables Atlas continues using the local `ATLAS_MEDIA_DIR` volume.

## VPS activation (after testing)

1. Create a Cloudflare R2 **Standard** bucket (e.g. `atlas-files`) with public access disabled.
2. Create **Object Read & Write** S3 API credentials scoped to this specific bucket.
3. On the VPS, edit the existing private `infra/production.env` (never commit it or paste credentials in chat):

   ```dotenv
   ATLAS_R2_ENDPOINT=https://YOUR_CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com
   ATLAS_R2_BUCKET=atlas-files
   ATLAS_R2_ACCESS_KEY_ID=your-r2-access-key-id
   ATLAS_R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
   ```

   The account ID is the one shown in R2 under the S3 API endpoint. Use the account's R2 S3 credentials, not a Cloudflare dashboard API token.

4. Run `npm run build:server` and the existing tests on the Atlas checkout, then deploy after review. Verify upload and public GET on a harmless sample image.
5. Preserve the `atlas_media` Docker volume. **Legacy media is not automatically copied**. Reads check R2 first and fall back to local files only when the R2 object is absent (404). Network/auth errors do not silently fall back.
6. Keep backups and confirm every original, thumbnail and preview in R2 before ever removing the legacy volume.

Partial R2 configuration intentionally fails startup. A missing or invalid bucket endpoint fails rather than sending secrets to an unexpected server. Do not put keys into the web app, Vercel variables or client-side code.

## Security boundaries

This is specifically Atlas's **Portfolio media backend**, not yet the general-purpose Atlas Files service. The `/api/media/*` download routes remain publicly accessible through Caddy. Only upload images and files intended for public portfolio visitors (e.g. a public CV). Confidential university or project documents will require separate authenticated routes and per-project permission checks.

Stable Atlas URLs allow migrating storage without updating the portfolio frontend. No public R2 domain is required. The public assets still pass through the Atlas VPS; CDN offloading can be added later.

## Rollback

Remove all four `ATLAS_R2_*` values and redeploy to restore local-only storage. Note that uploads made *only* to R2 after activation would not be readable in local-only mode; export or copy these objects first before rolling back the storage backend.
