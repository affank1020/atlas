# Atlas Web design system

## Product and dependency boundary

Atlas is the platform. Atlas Server owns data, execution, retrieval and contracts.
Atlas Web is the primary browser client, formerly Observatory. Internal package
names and historical audit client names may retain Observatory for compatibility.
Always develop **Server capability → stable API/service contract → Web surface**.
Do not create endpoints, synthetic production records or simulated connectivity to
fill navigation. No server implementation was changed for this redesign.

## Visual foundation

Dark graphite surfaces, warm white text, restrained indigo selection and crisp
controls define Atlas. Use typography and dividers before containers. Normal page
sections have no enclosing card; dialogs and individually selectable Projects do.
Use `src/tokens.css` as the authoritative palette and sizing contract.

| Role | Token |
| --- | --- |
| App and navigation backgrounds | `--bg`, `--bg-secondary` |
| Surface levels | `--surface`, `--surface-elevated`, `--surface-hover` |
| Dividers / input boundaries | `--border`, `--border-strong` |
| Content / supporting / metadata text | `--text-primary`, `--text-secondary`, `--text-muted` |
| Selection / button fill / selected background | `--accent`, `--accent-solid`, `--accent-soft` |
| Semantic outcomes | `--success`, `--warning`, `--danger`, `--information` |
| Semantic backgrounds | corresponding `--*-soft` tokens |

Spacing uses 4, 8, 12, 16, 24, 32, 48 and 64px (`--space-1` through `--space-8`).
Radius is 4px for small elements, 6px for controls and 10px for dialogs. Control
heights are 30, 36 and 44px. Motion is `--transition` (140ms); reduced motion removes
transitions and animation. Shadows are reserved for dialogs.

System sans-serif avoids external font requests and makes the client fast offline.
Page/project titles use `--text-title`, tight tracking and a 1.2 line height.
Section headings use `--text-lg`; body `--text-base`; controls `--text-sm`;
metadata `--text-xs`. IDs, schema fields, paths and source use `--font-mono`.
Legacy dense editors keep established layout dimensions, but consume color tokens.
No theme toggle existed; this release establishes dark mode only.

## Navigation and composition

`AppShell` owns the responsive sidebar, project switcher, breadcrumb context and
global Ask Atlas entry. Home is followed by Projects, Infrastructure (Activity),
Tools (existing Portfolio experiences), and collapsed Developer tools. Fabric is
reachable at its original URL as the Retrieval inspector under Developer.
Do not advertise search/commands until implemented. The topbar has room to add them.

`ProjectNav` provides Overview, Data, Views, Workspaces, Activity and Settings.
Existing project URLs open Overview; new section URLs append the section name.
Store and View URLs remain unchanged and retain contextual project navigation.
Settings exposes existing edit/archive operations. There are no empty Applications,
Nodes, Automations or Builder destinations.

Home shows actual server counts as a compact status line, project entry points and
recent audit events. Counts are not a task backlog or an online-node count. Do not
infer Node availability or unresolved attention from historical audit events.

## Primitive treatment

- Projects: quiet monograms, name and description; no random rainbow identity.
- Stores: field/type metadata, tabular records and monospace schema identifiers.
- Views: `ViewContainer` composes saved Views into Overview; `ViewFrame` retains
  sandboxing, CSP and the existing trusted action bridge. Its embedded chrome shows
  only a View label and standalone link; each saved View owns its own identity.
  Currently the first two active Views in server list order render; all others
  remain in Views.
- Workspaces: real registered path, adapter, Git state and Unity capabilities.
  Preserve the existing inspection controls and report errors as unavailable.
- Activity: chronological expandable event stream with actor, operation, outcome
  and timestamp; preserve pairing, filtering and polling behavior.
- Future Applications: explicit named launch entries with purpose and Open action.
  Never assume an Application is built from Views. Add only after a real contract.
- Future Nodes: trusted device/execution host identity, last-seen, actual
  connectivity, hosted Workspaces and capabilities. A Workspace is a project-owned
  resource hosted by a Node; a capability is an operation it can perform. Agent
  refers to an AI/software actor such as ChatGPT or Codex.
- Future Automations: project ownership, trigger, enabled state and actual run results.

## View compatibility

The immutable server View Kit v1 is unchanged. `viewTheme.ts` adds presentation
variables after Kit defaults and before user-authored CSS, within the returned
sandbox document. Saved CSS retains precedence. Script bytes and CSP are unchanged.
Documents without Kit v1 retain their own styling. Standalone server URLs apply
the same dark Kit token roles on initial load and refresh, before saved CSS;
no user View definitions were rewritten.

Embedded hosts do not write parameter changes into the parent route. Runtime
refresh parameters remain scoped to each View. Actions still execute only saved,
declared server actions. Never insert View HTML into the privileged React DOM.

## Responsive and accessible behavior

At 950px navigation becomes an explicit expandable Menu. Project tabs scroll
horizontally; panels and grids reflow. Store tables scroll inside their container,
not the page. Portfolio editing collapses into one column at 800px. Avoid adding
fixed minimum widths that force the body to overflow on a phone.

Use landmarks, real links, labeled controls, `aria-current`, visible focus rings,
status/alert regions and reduced motion. `Modal` uses native dialog focus containment,
Escape cancellation and focus restoration. Never substitute color for status text.
Keep author CSS isolated; test the shell at 390px and desktop widths.

## Examples and extension rules

Good: section heading, compact toolbar and one table with a fine divider.
Bad: panel containing a card containing another panel around each table row.
Good: show an explicit connection error or omit an unsupported destination.
Bad: green “online” indicator without a status contract, fake example records,
or a launcher that cannot launch anything.
Good: consume semantic tokens and reuse AppShell/ProjectNav/ViewContainer/Modal.
Bad: copy raw hex colors into a feature stylesheet or rewrite View content to theme it.

## Validation and follow-up boundaries

Build includes TypeScript checks. Run `npm run build` and `npm test` from the Atlas monorepo root.
No lint script/configuration currently exists. Regression tests cover routing
navigation, View theme precedence, View runtime/host, actions, Ask Atlas, Activity
and Workspace surfaces. Production write actions should not be used as smoke tests.

Potential follow-ups: persisted selection/order of overview Views when a suitable
contract exists; global search/command interface; multi-workspace selection (the
existing WorkspacePanel inspects the first registered workspace); full standalone
View theming via a separately versioned server presentation change. Nodes,
Automations and Applications remain contract-dependent future work.
