# Atlas Views authoring guide (Stage 3)

A View is a project-owned, persistent definition: **manifest + queries + template + CSS + script + declared actions**. Atlas executes saved Store queries on the server, renders Handlebars against their current results, and sends a complete document to Observatory's isolated iframe. No AI or user JavaScript runs on the server.

## Capability progression

- V1: persistent project-owned query/HTML/CSS definitions.
- V2: ViewKit, sandboxed JavaScript, declared URL parameters and manual editing.
- V3: declared Core actions, stable record metadata, deterministic refresh and standalone pages. Existing V1/V2 definitions work without author edits. Migration `010_view_actions.sql` persists actions with an empty default; existing scripts, manifests and slugs retain their storage.

## Authoring workflow

1. Inspect `list_projects`, `list_stores` / `get_store`, and sample records.
2. Use `list_views` / `get_view` before changing an existing page.
3. Compose View Kit components, semantic HTML, and narrowly scoped CSS. Prefer built-in behaviour. Keep layouts responsive, labels accessible, and empty/missing states explicit.
4. Call `preview_view` with the project ID and definition. It validates and queries without saving or auditing a mutation.
5. Call `create_view` (also requires `name`) or `update_view` (requires `viewId`). Use `expectedUpdatedAt` from `get_view` to avoid overwriting concurrent edits.
6. Call `render_view`, then inspect it in Observatory. API render responses include query data, diagnostics, rendered HTML, CSS, manifest, script, resolved parameters and the sandbox document.

`template` is accepted as an alias for the existing `html` field. Storage and `get_view` continue returning `html`; supplying both with different values fails. `queries` and `css` are required on creation; an empty array/string is valid. Updates patch supplied fields. To remove a manifest use `manifest: null` and remove any dependent script/components at the same time. `script: ""` removes a script. Names and optional slugs remain unique within the project.

`get_view_history` returns immutable audit events with complete previous/resulting definitions. These are the existing revision semantics, now including manifest and script. There is no separate restore endpoint; an author can inspect a snapshot and explicitly save selected fields as a new update.

## Manifest and versioning

```json
{
  "viewKitVersion": 1,
  "layout": "dashboard",
  "capabilities": ["client-script", "url-params"],
  "params": { "q": "" }
}
```

- `viewKitVersion`: currently only `1`; required when using `atlas-*` components. Unsupported versions fail instead of silently switching. Version 1's authoring contract is retained; breaking changes require a new version module.
- `layout`: optional `dashboard`, `document` (48rem) or `wide`. Sets the default on `atlas-page` elements.
- `capabilities`: `client-script` (custom saved JavaScript), `url-params` (declared parameter state), and `record-actions` (declared mutations) are implemented. Unknown/duplicate capabilities and unknown manifest fields fail.
- `params`: declared string parameters and defaults. Requires `url-params`; up to 16 names (letters/numbers/underscore, starting with a letter, max 40 characters), values up to 500 characters. Reserved prototype names are rejected.

Views without a manifest keep legacy HTML/CSS rendering with a script-disabled iframe. No mass migration is required. Stable UUID routes, ownership, archive behaviour and audit history are preserved.

## Queries, templates and helpers

A query has `name`, `storeId`, optional `filters`, `sort`, and `limit` (1–100, default 100). At most 16 queries per View. Stores must be active and belong to the View's project. Fields, operators and directions are validated. Parameters never change query definitions or produce SQL.

A query named `applications` exposes an array of flattened record **data**, enriched with `_atlas: { id, storeId }` as `applications` in Handlebars and `atlas.data.applications` in JavaScript. Query names `params`, `constructor`, `prototype`, and `__proto__` are reserved. Rendering reads current records; it does not poll or subscribe automatically.

Use `{{#each applications}}…{{else}}…{{/each}}` and `{{#if applications}}` for empty states. Missing values render empty; use `{{value field}}` for an em dash. Standard interpolation escapes HTML, and the final HTML is validated again after rendering.

Deterministic helpers:

| Helper | Example | Behaviour |
|---|---|---|
| `value` | `{{value role}}` | Missing/null/empty → em dash |
| `number` | `{{number count}}` | en-GB, up to two decimal places |
| `percent` | `{{percent ratio}}` | Fraction to percentage, up to one decimal |
| `date` | `{{date appliedAt}}` | en-GB medium date, UTC; use ISO input |
| `eq` | `{{#if (eq status "active")}}…{{/if}}` | Strict equality |

## View Kit v1 reference

Components are supplied once by Atlas at render time, never copied into each saved definition. They use semantic child elements and shared styles without shadow DOM, so View CSS can compose them.

| Component | Attributes / children |
|---|---|
| `atlas-page` | Page padding and width; optional `layout="dashboard\|document\|wide"` |
| `atlas-header` | `title` → heading, `subtitle` → paragraph; optional extra children |
| `atlas-section` | Spaced content region; supply a heading |
| `atlas-card` | Surface, border, radius, padding; arbitrary semantic children |
| `atlas-stat-grid` | Responsive grid of stats |
| `atlas-stat` | `label`, `value`; missing value → em dash |
| `atlas-badge` | Text children; `tone="success\|warning\|error\|info"` or neutral |
| `atlas-table` | Wrap a native table with `thead`, `tbody`, labelled headers/caption. `sortable` adds keyboard-operable header buttons. `filterable` adds a labelled search box and no-results state. `search-label` customises its label; optional `param="q"` stores search in a declared URL parameter |
| `atlas-tabs` | Direct children with `label="…"` become panels. `label` names the tab group. Arrow keys, Home/End, focus order, selected state and ARIA relationships are provided |
| `atlas-progress` | `label`, numeric `value`, optional `max` (default 100); native accessible progress |
| `atlas-empty-state` | Optional `title`, descriptive children; status semantics |
| `atlas-loading` | Descriptive children; polite live status |
| `atlas-error` | Descriptive children; alert semantics |
| `atlas-button` | Text children, `label`/`aria-label`, `disabled`, `loading`, optional `variant="secondary"`; native button semantics. The `disabled`/`loading` properties update dynamically |
| `atlas-toast` | Text children; `tone="success\|error\|info"`; live status/alert semantics. Usually created via `atlas.toast` |

Use native `details`/`summary` for expansion and `dialog` with a labelled close button for modal behaviour. Supply accessible labels for custom controls. Tables scroll horizontally at narrow widths; they do not discard columns. Component attributes initialise at connection time; for custom dynamic displays, update their child DOM directly.

Table search operates on the returned rows (up to the query limit), using all row text. Sorting compares numeric values numerically and text using en-GB numeric collation. Search state can be bookmarked; sort order and tab selection are local state in v1. Newly inserted tables/components can initialise when connected, but replacing rows does not automatically rerun an existing search.

### Tokens

- Typography: `--atlas-font`; headings scale with viewport width.
- Spacing: `--atlas-space-1`, `-2`, `-3`, `-4`, `-6`, `-8` (.25rem through 2rem).
- Widths: `--atlas-page-width` (72rem), `--atlas-document-width` (48rem).
- Surfaces: `--atlas-bg`, `--atlas-surface`; `--atlas-border`, `--atlas-radius`, `--atlas-shadow`.
- Text: `--atlas-text`, `--atlas-muted`, `--atlas-accent`.
- States: `--atlas-success`, `--atlas-warning`, `--atlas-error`, `--atlas-info`.
- Tables: `--atlas-table-stripe`.
- Breakpoint reference tokens: `--atlas-breakpoint-mobile` (40rem), `--atlas-breakpoint-tablet` (64rem). CSS custom properties cannot be used in media-query conditions; use these documented numeric breakpoints in View media queries.

The Kit supplies visible focus indicators, readable contrast, reduced-motion defaults, and responsive spacing. Prefer tokens over repeating theme colours in saved CSS.

## Runtime API and URL state

```js
atlas.onReady(() => {
  const applications = atlas.data.applications;
  const query = atlas.params.q;
  document.querySelector('#count').textContent = String(applications.length);
  // In response to a user interaction:
  atlas.setParam('q', 'LSEG');
});
```

- `atlas.data`: deeply frozen query data.
- `atlas.params`: immutable snapshot of current local parameter values.
- `atlas.onReady(callback)`: runs after DOM and shared component setup.
- `atlas.setParam(name, stringOrNull)`: updates local state and requests a parent URL-state update. Only declared names are allowed; `null` removes a URL value (reload then uses its manifest default).

Observatory uses `#/projects/PROJECT_ID/views/VIEW_ID?q=LSEG`. It accepts parameter messages only from the current iframe window, with opaque `null` origin, and only for declared names/valid values. It changes only that route's encoded query string using replaceState. The shared trusted host also handles only declared action calls and deterministic refresh requests, tied to the current render identity. Reload/Refresh data resolves URL values through the server and supplies them as template `params.q` and runtime `atlas.params.q`. setParam does not requery or rerender the server template automatically; custom scripts should update their local UI or call `atlas.refresh()`. Editor preview state stays inside the preview and does not change the saved View URL.

## Compact example

Supply the actual project ID and same-project Store ID when calling `create_view` with this definition and a name:

```json
{
  "manifest": {"viewKitVersion":1,"capabilities":["client-script","url-params"],"params":{"q":""}},
  "queries": [{"name":"applications","storeId":"REPLACE_WITH_STORE_UUID","limit":100}],
  "template": "<atlas-page><atlas-header title=\"Applications\"></atlas-header><p id=\"count\"></p><atlas-table filterable sortable param=\"q\" search-label=\"Find application\"><table><caption>Current applications</caption><thead><tr><th scope=\"col\">Company</th></tr></thead><tbody>{{#each applications}}<tr><td>{{value company}}</td></tr>{{/each}}</tbody></table></atlas-table></atlas-page>",
  "css": "#count { color: var(--atlas-muted); }",
  "script": "atlas.onReady(() => { document.querySelector('#count').textContent = String(atlas.data.applications.length) + ' applications loaded'; });"
}
```

The full Graduate Applications reference is in `apps/server/examples/views/graduate-applications.json`. `scripts/migrate-graduate-view.mjs PROJECT_ID VIEW_ID` previews and updates that named dashboard through MCP while retaining its original queries and stable ID. Migration snapshots remain in audit history.

## Security and supported JavaScript

View code and data are untrusted relative to Atlas Core and Observatory. HTML is parsed with parse5 and validated before saving and after interpolation; scripts are syntax-parsed with Acorn, never evaluated on the server. Authoring validation rejects unsupported markup, unsafe URL/resource attributes, inline event handlers, network/navigation APIs, reflection/evaluation, imports and dynamic property access. Syntax restrictions return errors; they are not a replacement for browser isolation.

Stage 2/3 documents run in `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"`; Stage 1 frames allow only popups and popup sandbox escape. Neither grants `allow-same-origin`, forms, downloads, top navigation, or storage permissions to the View. The iframe has an opaque origin and cannot read the Observatory DOM, its credentials or storage. Validated `<a href="https://...">` and `<a href="http://...">` links open in a new tab with `target="_blank" rel="noopener noreferrer"`; templated URLs are checked after interpolation. Other schemes, relative URLs, and malformed URLs are rejected. A deny-by-default CSP allows only SHA-256-hashed bootstrap/Kit/saved scripts and inline CSS; network connections, external assets, nested frames, workers, eval and form submissions are blocked. Serialized query data escapes script delimiters. There are no external script dependencies. The HTTP server additionally rejects opaque-origin POST requests, including MCP and mutation endpoints.

Scripts can use their local DOM, normal arrays/strings/numbers, events, canvas and dialogs. Use named properties and `array.at(index)`; dynamically computed property names are deliberately unsupported. DOM construction uses direct `document.createElement('supported-tag')` and literal safe attribute names in `setAttribute`. HTML injection APIs such as `innerHTML` and `insertAdjacentHTML` are rejected; use `textContent`, `createElement`, and `append`. Custom scripting is deliberately smaller than unrestricted web JavaScript. Script errors appear within the View.

A browser iframe is not a CPU/memory quota or a general hostile-code virtual machine: an infinite loop can make a tab unresponsive. Do not treat Views as arbitrary third-party application hosting. Browser policy enforcement should be rechecked when changing this runtime or supported scripting surface. Tests deliberately bypass authoring validation to verify the underlying browser boundary.

## Observatory editor

Open a project → New View, or open an existing View → Edit View. Edit name, slug, manifest JSON, actions JSON, queries JSON, HTML, CSS and JavaScript. Open View opens the canonical standalone page. Draft editing preserves all these fields. Saved View actions work in the normal viewer; editor previews disable writes by default. Explicitly enabling saved actions in preview permits real Core writes, constrained by the persisted declaration (unsaved action edits grant no permissions). Action failures appear in the editor and reject the script promise. Available Store schemas and returned query data are inspectable. Update preview runs the same validation/query/render path without saving. Save View creates an audited update with a concurrent-edit check. Reload saved version resets the draft; Cancel discards it. Desktop/Mobile changes preview width. Revision history exposes full saved snapshots. Validation errors are shown beside the editor. This is a lightweight textarea editor, not a visual layout builder.

## Verification

Backend tests cover legacy/current rendering, persistence, audit snapshots, archive semantics, query/manifest/script validation, preview, concurrency and the reference dashboard. Observatory tests cover the iframe contract, parameter bridge and editor preview/save behaviour.

For browser regression checks: `npm run build`, generate a temporary fixture with `node test/view-browser-fixture.mjs apps/web/public/__view-runtime-test.html`, open that path in the Observatory dev server, check PASS and exercise tabs/search/sorting, then delete the generated public file before a production build. The fixture verifies parent DOM, cookies, storage, network, workers, eval, query data, CSS, components and parameter messaging using the actual browser.

V3 regression coverage includes action ownership/schema boundaries, revoked declarations, create/update, normal audit provenance, persistence after reopening Core, standalone routes, refresh, host message validation and unchanged University ranking. The real-browser fixture `test/run-views-v3-browser.mjs` runs the production server on port 3001 against an isolated PostgreSQL schema; stop it with SIGTERM to clean up. No AI is involved in View actions or refresh. Archive/destructive actions, a schema-aware form builder, external links, npm dependencies and a visual layout editor remain deferred.

## Standalone pages

Active Views with a slug have a canonical Core URL: `/projects/PROJECT_ID/views/SLUG`. For the local server this starts with `http://127.0.0.1:3000`. Reloading resolves the persisted definition and current Store data. Unknown/archived Views return 404. Declared parameters use a normal query string, for example `?module=MATH37011`. Slugs stay stable until explicitly edited; renaming a slug changes its URL.

Standalone and Observatory use the same server render document and shared trusted message bridge. The standalone shell fills the viewport and has no editor chrome. `render_view` returns `standalonePath` when available.

## Declared actions and refresh

Add `record-actions` to the manifest capabilities, and persist a declaration:

```json
{
  "actions": [{
    "name": "completeTask",
    "type": "record.update",
    "storeId": "REPLACE_WITH_STUDY_TASKS_UUID",
    "allowedFields": ["status"],
    "fixedData": {"status": "completed"}
  }]
}
```

At most 32 unique named actions are supported. Types are `record.update` and `record.create`. Every field must exist in the active same-project Store schema. `fixedData` keys must also be in `allowedFields`. Dynamic input must not supply fixed fields, even with identical values. Create accepts `{data: {...}}`; update requires `{recordId, data?: {...}}`. Core validates required fields, enums and other field types. Updates merge with existing data through the normal Core update path.

Record identity is available as `{{_atlas.id}}` inside a query iteration and `atlas.data.pendingTasks.at(0)._atlas.id` in JavaScript. User fields retain their flattened names; metadata cannot collide with valid Store field names.

```html
<atlas-button id="complete">Complete</atlas-button>
```

```js
atlas.onReady(() => {
  const button = document.querySelector('#complete');
  const task = atlas.data.pendingTasks.at(0);
  button.disabled = !task;
  button.onclick = async () => {
    button.loading = true;
    try {
      await atlas.action('completeTask', {recordId: task._atlas.id});
      atlas.toast('Task completed', 'success');
      await atlas.refresh();
    } catch (error) {
      atlas.toast(error.message, 'error');
    } finally {
      button.loading = false;
    }
  };
});
```

- `atlas.action(name, input)` resolves with the normal Core record result after the durable write; failures reject with a readable error.
- `atlas.refresh()` reruns declared queries and replaces the iframe document without reloading the browser page. Templates, frozen `atlas.data`, components and onReady callbacks initialise from one fresh server result. Local DOM/tab state resets; declared URL parameters persist. Code after refresh should not be relied on in the discarded document.
- `atlas.toast(message, tone)` displays accessible local feedback. It is transient and disappears on a document refresh.
- `atlas.setParam('module', 'MATH37011'); await atlas.refresh();` provides safe internal navigation.

MCP `create_view`, `update_view`, `get_view`, `list_views` and preview/render responses carry actions. Omitted fields on update are preserved; `actions: []` removes declarations. `execute_view_action` takes `{projectId, viewId, action, input}`. It accepts no caller-selected Store, mutation method or provenance. Manual editor previews use this same endpoint and persisted permission check.

### Action security and audit

The iframe never receives generic fetch, SQL, filesystem or arbitrary server-method access. The trusted parent binds messages to its current iframe, opaque origin and render identity, validates method/action names and parameters, and serialises operations. Server-side code rereads the persisted View and revalidates its active project, Store, declaration, fields, fixed values and target record inside the same transaction as the normal Core mutation. Changing a client payload or stale preview cannot widen permissions.

Normal record audit events include project/store/record IDs, `viewId`, and `client: view:VIEW_ID:action:ACTION_NAME`. View definition history remains separate from record mutation history. This extends the existing Core access model; it does not introduce a new end-user authentication system.

## University reference implementation

`apps/server/examples/views/university-v3.json` preserves the original twelve queries and deterministic Focus Now ranking from `university-v2-reference.json`. Four additional queries supply module topics, assessments, recent activity and attempts. Start and Complete declare only Study Tasks `status` writes, fixed to `in_progress` and `completed`. Successful writes refresh the pending task list and recalculate Focus Now locally, without Fabric or Ask Atlas.

Module buttons set the declared `module` URL parameter; one persistent View provides the overview and module detail tabs. The saved **Task Prioritisation Policy v1** remains unchanged and visible. `scripts/upgrade-university-view.mjs` previews and updates the known dashboard with a concurrency check, and verifies that Project Guidance records are unchanged.
