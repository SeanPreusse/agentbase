# AgentBase

Persistent project memory for AI agents. Pick up work in a fresh Codex session with the plan, decisions, tasks, handoff, and analysis evidence still connected.

**Version 0.7.0 · Local MCP alpha + native macOS inspector · Codex first · No web app · No account or model API key**

AgentBase is a stdio MCP server, three Codex skills, a diagnostic CLI, and an optional native macOS inspector. It does not run an agent, make model calls, or launch a background web service. The inspector reads committed state through a read-only bridge; its Skills workspace writes catalog metadata through the existing Agentbase skill tool.

## Native live inspector (macOS)

```sh
npm run ui
```

This builds and opens `build/Agentbase Inspector.app`, a SwiftUI desktop window. Requires macOS 14+, the Xcode command-line tools (`swiftc`), and Node.js 24.15+. Subsequent launches can open the built `.app` directly. `npm run ui:build` builds without opening it. The app bundles its read-only bridge and remembers the Node executable and checkout paths used at build time; rebuild if those move. This is a locally signed development app, not a notarized public macOS distribution.

The inspector opens as a full-window force-directed knowledge graph. Its root is the actual project folder (for example, `agentbase2`), identified by the stable project ID and distinguished with a larger double-ring node. Folder edges connect each visible group of related information; they describe project membership, while evidence and parent/child links retain their recorded meaning. The root is derived from project registration, rather than saved as a memory. Click it or the folder button to inspect the path, project goal and linked groups. A compact Graph / Kanban / Skills switch changes between the graph, live task board, and project skill catalog. The Skills workspace can search, add, edit, enable and disable skill metadata; it does not fetch or install referenced files. Catalog writes go through `skill_save` with version checks. The graph stays mounted while hidden, preserving its camera and node positions. The default view centers on generated project information: findings, decisions, analyses, resources and their supporting work. Plugin configuration and feature-map records can be marked `graph_role: background`; they stay in memory and search but do not become visible knowledge hubs. Sessions, handoffs, superseded/stale memory and unrelated closed tasks are also excluded from the default view. Use “Show background records” in the graph menu for the full record view. Concepts, tasks, memory, plans, handoffs, resources, datasets and analyses have distinct node colors. Parent-to-child arrows show hierarchy; the selected node highlights its neighbors. Click a node or a search result to inspect content, provenance, linked resources and incoming/outgoing connections in an on-demand floating detail card. Selecting a node does not resize the canvas.

Drag a node to reposition it or drag the background to pan. Scroll or pinch to zoom around the pointer; use the +/− keys or the corner Fit button for camera controls. Escape closes details; 0 fits the graph. Gravity, repulsion and link forces run automatically, without exposed tuning sliders. The compact search/project control has an options menu for labels, hidden node types, local graph, pause and reconnect; there is no permanent toolbar or sidebar. Local shows the selected node's two-hop neighborhood. New visible MCP records spawn near their linked neighbors and grow into view; new edges fade in. Existing node positions and the camera are preserved across live refreshes. Layout positions are view state, not stored project facts. Sessions are hidden by default to reduce noise. Native node search covers the displayed titles and summaries; MCP `graph_get` searches full supported text fields before expanding links.

The project/store chooser, one-second live updates, pause/resume and automatic reader recovery remain. The default All Projects overview shows each registered project as its own graph group, including child concepts, tasks, and source references connected by their saved relationships. An unlinked task remains attached to its project folder; a linked task connects through its relevant records. There is no shared root node. Its combined Kanban board labels tasks by project. Graph search scans all saved records across projects, including work outside the visible graph; press `/` to focus search and Return to open the first result. Select a project from the dropdown for its full graph and task board. No browser, web server, model call or network connection is involved. Selecting a resource displays its reference; it does not fetch or execute it. A project graph displays up to 350 nodes from a source window of 10,000 visible records and 5,000 returned edges; MCP can return up to 500 nodes. Omitted node counts are shown. Forgotten records and their edges are excluded.

Detail cards have bounded back/forward record history, cleared when changing projects or data stores. Use “Show in graph” from a Kanban card context menu or detail header to center that task in the existing graph; task details in Graph can jump back to the board.

Kanban shows Backlog, Ready, In progress and Done, with Review, Blocked and Cancelled columns when those statuses exist. Cards use recorded task statuses, show ownership and unmet dependencies, and open the same floating detail card. Task search and status filters narrow the board. Attention uses explicit blockers, unmet dependencies, or expired owned leases; it does not infer agent activity. Jumping to a task clears conflicting board filters. The board starts with the newest 200 tasks plus any explicitly loaded older task. “Load 200 more” expands the window up to 1,000 tasks without clearing filters; the footer discloses any remaining older work. It does not change task status through drag and drop.

## Native result charts and movable details

Saved analyses open with a native Chart / Table switch. Choose X and numeric Y columns and Bar, Line or Scatter. Date columns default to a line chart; other results default to bars. Lines and scatter require a numeric/date X axis (or the explicit Row axis). Line/scatter points are ordered by X; bars retain saved row order and refuse duplicate labels rather than silently stacking or aggregating them. Hover a chart to inspect a point’s saved value. Missing/unsupported axis values are excluded and counted; integers outside the exact charting range remain available in the table. Charts do not rerun SQL or read source files.

Opening an analysis loads up to 1,000 saved rows into the read-only inspector. Other analyses retain 20-row previews to bound streaming snapshots. The result view reports loaded rows, any additional saved rows omitted by the inspector, and whether the original SQL result was truncated when saved. The table retains original saved representations and scrolls independently with a fixed header.

Drag a detail card by its header to move it within the window. Its position is constrained so the header remains reachable after resizing. Use Expand details / Restore details, or double-click the header, for a full-window detail view. The graph stays mounted underneath. Graph and Kanban options include Toggle full screen for native macOS full-screen mode.

## Native Codex connections

The puzzle-piece Connections button is available in Graph and Kanban. Its compact panel reads the Codex CLI plugin inventory and shows the installed version and enabled state. Install registers the existing Agentbase package as the `agentbase-local` marketplace and installs its plugin with skills and MCP. It refuses to replace a marketplace belonging to another installation. An installed plugin has an enable switch; settings changes back up `config.toml`, change only Agentbase’s plugin entry through Codex’s configuration API, and verify the resulting inventory. Unrelated settings and approval policies are preserved. Setup operations are serialized with a local SQLite lock that is released if the process exits.

“Check setup” starts the installed MCP in a temporary Agentbase store, validates its version and expected tools, then removes the temporary store. It calls no model and does not access your project records. A passing check confirms the installed server can start; it does not prove an existing Codex session has loaded it. Disabling applies to new sessions. Reconnect existing Codex sessions to unload or reload the MCP. Turning it off retains project memory. Project and managed policies can override user-profile settings.

This first connection adapter supports Codex. The development inspector uses the Node/Codex paths and Agentbase package location captured at build time; rebuild if these move. It does not yet bundle a standalone public installer/runtime or adapters for Claude and ChatGPT.

## Concepts, resources and graph search

The full MCP graph includes a derived folder root; `graph_get` can focus it using the project ID. Folder membership does not expand ordinary keyword searches or local semantic neighborhoods into unrelated groups. The root is inspectable, while edits and graph links apply to stored records.

Three MCP tools share the graph used by the inspector:

| Tool | Purpose |
| --- | --- |
| `knowledge_save` | Create or revise a sourced concept or resource, with optional concept parent. |
| `graph_link` | Add/remove a directed `related` or `resource` link between existing records. |
| `graph_get` | Keyword search, bounded graph traversal, local neighborhoods and backlinks. |

Knowledge nodes use existing memory IDs and remain available through ordinary record search, export and backup. Knowledge and memory capture tools accept optional `graph_role: content` or `background`; memory_update can reclassify a record using its existing status and current version. Updates require current versions; task links respect active ownership. Parents must be concepts in the same project. Parent cycles, cross-project links and edits to forgotten nodes are rejected. Pass `parent_id: null` to detach a node. Resource nodes require `uri` as an absolute path or http(s)/file URI; referenced files are not automatically included in backups.

Use `[[Exact title]]`, `[[record_id]]` or `[[Exact title|display label]]` in concept content, task descriptions, handoff summaries or plan goals. Exact, case-insensitive titles resolve only when unique; missing and ambiguous names are returned as unresolved links. Existing task dependencies, plan/session/task references, saved-analysis datasets, evidence and explicit record links are also graph edges. No relationship is invented from similarity.

```json
{"project_id":"project_ID","node_type":"concept","title":"Import pipeline","content":"Uses [[Content hashing]].","source":"Approved project design","epistemic_status":"user_stated","actor":"codex","request_id":"new-unique-id"}
```

Call `knowledge_save` with that payload, then attach a task through `graph_link` or its `related_ids` on creation. Use `graph_get` with `view: content` for the information view or its default `view: all` for complete context. Use `query` for keyword matches plus neighbors, or `focus_id` for a local graph with backlinks. `depth` ranges from 0–3 and `limit` from 1–500. Search is lexical graph traversal, not an embedding search. A `source_truncated` flag identifies the 10,000-record source cap. Use `record_get` to expand complete records.

`npm run test:graph` verifies the installed MCP tools, concept hierarchy, resources, wikilinks, backlinks, search limits, restart persistence and forgetting in a temporary store. `npm run test:ui` checks native graph physics, stable positions, pinned dragging, gravity and local-neighborhood depth, alongside connection recovery.

The Skills workspace seeds each selected project with missing Agentbase bundled skills for project continuity, local data analysis, and backup/recovery. The catalog is searchable; selected skills show their triggers, tags, applicability, and source reference. Add or edit metadata from the separate form. Refresh never overwrites existing entries, and skills are referenced rather than fetched or executed by the Inspector.

## Skill catalog and recommendations

Project skill entries let an agent record short metadata for skills that are useful in that project, then request deterministic recommendations for a task. They are separate from Codex's installed skill inventory: Agentbase does not install, fetch, execute, or inject skill instructions.

| Tool | Purpose |
| --- | --- |
| `skill_save` | Create or update a project skill summary, source reference, trigger phrases, tags, and applicability phrases. Updates use `expected_version`. |
| `skill_list` | Search or page through active, disabled, or all project skill entries. |
| `skill_recommend` | Rank active entries against a task ID and/or task description and return the matching metadata and reasons. |

Recommendation scoring is lexical and explainable: matching trigger phrases rank highest, then tags, then applicability phrases. No match means no recommendation. Results omit skill instructions; the host agent decides whether a suggested skill is relevant and loads it through its normal skill mechanism. A source reference may be a local path or HTTP(S)/file URI, and Agentbase does not open it.

```json
{"project_id":"project_ID","actor":"codex","request_id":"new-unique-id","title":"Spreadsheet analysis","description":"Analyze CSV and Excel workbooks and preserve formulas and provenance.","triggers":["analyze spreadsheet","work with xlsx"],"tags":["spreadsheet","csv","xlsx"],"applies_to":["data analysis"],"source":"/path/to/skill/SKILL.md"}
```

Use `skill_recommend` with `task_id` or `query`; inspect the reasons and choose whether to load the referenced skill. Entries are scoped to one Agentbase project and do not change host-installed skills.

The clock button in either view opens the latest 100 saved changes, including the record title, action, actor and relative time. Click an entry to inspect its record, including records outside the recent window. Forgotten or deleted records cannot be opened from the change list. Inspector search scans saved project titles, full text, sources, progress/completion summaries and saved SQL independently of the visible graph and recent record windows. It matches words in any order, ignores case and accents, and ranks exact titles and other title matches before body matches. The scrollable list shows up to 50 results with text previews and reports the total. Completed work remains searchable; background records follow “Show background records.” Forgotten records stay excluded. Selecting a result loads its record and a bounded linked neighborhood into the graph, retaining existing positions and zoom. Input is debounced by 250 ms, limited to 200 characters, and stale responses are hidden. Resume updates to run project search while paused.

For integrations, `node bin/agentbase.mjs inspect --watch` emits one bounded JSON snapshot per second. Add `--project agentbase:all` for the combined overview or `--project project_ID` for one project, `--record record_ID` to load an older record and up to 30 linked records' summaries, add `--search "query words"` for bounded search results alongside the graph, add `--task-limit 400` to expand task history (clamped to 200–1,000), or omit `--watch` for a single snapshot. `npm run ui` opens All Projects; pass `-- --root /absolute/project/folder` to open a project. For a built app, `open -a "build/Agentbase Inspector.app" --args --root /absolute/project/folder` selects that folder. The read-only bridge and CLI accept `--root /absolute/project/folder` too, resolve the longest registered containing folder, and report unregistered folders instead of silently selecting another project. An explicit project selection overrides folder matching. Linked worktrees use their registered working root while retaining the same project identity. The inspector remains optional: MCP and CLI workflows do not require Swift or the desktop app.

## Run locally

Requires Node.js **24.15 or newer** and npm. Memory and task tools work on any supported Node platform. Data tools additionally require macOS `sandbox-exec` or Linux `bubblewrap` (`bwrap`). Windows analysis is not implemented.

```sh
npm ci
npm run build
npm test
npm run demo
node bin/agentbase.mjs doctor
```

The demo creates temporary data, saves an investigation, restarts the application service, retrieves its continuation context, completes the task with evidence, and removes its temporary files. It requires the analysis sandbox.

`doctor` launches the actual MCP server in a temporary store and tests tool discovery, storage, retries, and sandboxed analysis. It reports separate core and analysis results, cleans up its files, and does not register projects in your personal store. Unsupported analysis platforms report degraded capability; failed checks return a nonzero exit code.

## Connect Codex

Print configuration containing the absolute paths for this checkout:

```sh
node bin/agentbase.mjs config
```

Add that output to your Codex `config.toml` under `mcp_servers.agentbase`, then reconnect the MCP server or restart your client. The command only prints configuration; it does not modify your settings. The checkout must remain built at that location.

For the full skill experience, the root `plugin.json`, `mcp.json`, and `skills/` form an Agent Plugins package. This repository includes `.agents/plugins/marketplace.json` for local discovery in compatible Codex clients. Build and install dependencies before selecting the local plugin. Plugin installation, skill discovery, tool execution, disable/enable, and restart recovery are tested through Codex CLI 0.147.0 and its app-server. Separate model-driven evaluations test capture and continuation; no single evaluation guarantees capture during every conversation. Do not configure both the standalone server and the plugin server unless you intend duplicate connections.

### Install and develop the plugin

From this source checkout, with a recent `codex` CLI on PATH:

```sh
npm run plugin:up
npm run plugin:status
npm run test:installed
```

`plugin:up` builds the checkout, registers its local marketplace if needed, installs/enables Agentbase through Codex, and compares the cached runtime and skills with the source build. It refuses to silently replace a marketplace pointing to a different checkout. `plugin:status` checks the installed version, enabled state, and cache freshness.

To take the plugin down for development and bring it back:

```sh
npm run plugin:down
# Edit the source.
npm run plugin:up
```

These commands back up Codex's config and change Agentbase's installed/enabled state while preserving other settings and tool approval policies. Disabling prevents future sessions from starting the plugin; reconnect existing sessions to unload their running MCP process. After bringing it up, reconnect Codex or start a fresh session to load the rebuilt cache. Running processes do not hot-reload compiled code. Neither command deletes project memory.

`test:installed` requires the installed plugin and runs it from Codex's cache. It tests simultaneous first opens, six independent MCP processes, competing claims, idempotent retries, forced termination with in-flight writes, cold recovery, immutable data, and parallel sandboxed queries. It also creates an isolated Codex profile to verify plugin/skill discovery, execute tools through Codex itself, kill/restart the host, and disable/re-enable the plugin. Test data and the profile are removed afterward. The test invokes no model and does not use an API key.

Installed-test reports are generated locally under `test-results/` and are not part of the source release. They distinguish protocol and host validation from model behaviour evaluation.

### Evaluate memory capture with a real model

```sh
npm run eval:memory -- --timeout-seconds=600
```

This opt-in evaluation uses the existing Codex ChatGPT login and consumes model usage. It runs a small invoice-import investigation, terminates the first session after a successful checkpoint, and starts a fresh session with only a request to continue unfinished work. The grader checks persisted constraints, planning, tasks, handoffs, independent original acceptance tests, and evidence-backed completion. It permits the agent to add useful tests without altering the grader's frozen acceptance cases.

The evaluation creates an isolated Codex profile and store from the installed plugin and removes the profile and store afterward. Prompts, tool traces, synthetic fixture code, and retained project records are written to the ignored `test-results/` directory for local review. `--output=path` selects another report directory. Each phase has a bounded timeout (30–900 seconds; default 300).

By default it preserves the configured model and reasoning effort. If the CLI's ChatGPT login rejects the configured model, `--account-default` uses the CLI/account default in the temporary profile and reports the choice; normal user settings remain unchanged. For example:

```sh
npm run eval:memory -- --account-default --timeout-seconds=600 --output=test-results/model-memory-0.2.2
```

A single successful scenario demonstrates that workflow, not general reliability. Inspect the traces and scores before expanding the evaluation set. The 0.2.2 skill also separates session-only stop conditions from durable project constraints, following an issue observed in the initial live evaluation.

Evaluation reports can contain prompts and project records. Review them for sensitive information before sharing them.

Try this in Codex once connected:

> Use Agentbase for this project. Retrieve its current context, create a plan for the import bug, and checkpoint useful discoveries as you work. Capture tasks with acceptance criteria and preserve the evidence behind decisions.

In a fresh session:

> Use Agentbase to continue the import investigation. Check the latest handoff and current repository state before resuming.

The bundled `agentbase-resume` skill guides continuity, planning, task capture, and completion. `agentbase-analyse` guides data analysis and provenance. Skills depend on host discovery and agent tool use; they do not guarantee capture of every turn. There are no lifecycle hooks or transcript scraping.

## What works

- Stable project IDs, project discovery, shared Git worktree identity, and explicit attachment after directory moves.
- Plans with milestones, acceptance criteria, constraints, assumptions, and open questions.
- Tasks with dependencies, cycle detection, priorities, atomic leases, recovery after expiry, and evidence-backed completion.
- Sourced facts, decisions, constraints, lessons, supersession, and logical forgetting.
- Structured checkpoints, optional atomic task-progress updates, and checkout-specific repository change detection.
- Full-text search and character-budgeted context packets with IDs for expansion.
- Immutable CSV, JSON/JSONL, and Parquet snapshots with content hashes and dataset versions.
- Restricted DuckDB SELECT queries with saved SQL, input versions, bounded results, and separate interpretation.
- Local JSON/CSV result exports and consistent project metadata export.
- Optimistic version checks, transactional audit metadata, retry keys, and cross-process SQLite coordination.

## Tool guide

| Workflow | Tools |
| --- | --- |
| Open and resume | `project_resume`, `project_open`, `project_list`, `project_attach`, `session_start`, `context_get`, `handoff_get` |
| Retrieve details | `record_get`, `search` |
| Plan and track work | `plan_save`, `task_create`, `task_list`, `task_update`, `task_claim`, `task_complete` |
| Keep knowledge current | `memory_record`, `memory_update` |
| Preserve progress | `checkpoint_save` |
| Analyse data | `dataset_import`, `dataset_inspect`, `analysis_run`, `artifact_export` |
| Export metadata | `project_export` |
| Concepts and graph navigation | `knowledge_save`, `graph_link`, `graph_get` |
| Back up and recover state | `project_backup`, `backup_verify`, `project_restore` |

All writes after opening a project require `project_id`, `actor`, and `request_id`. Use a distinctive actor per agent session. Reuse an identical request ID and arguments only to retry the same operation. A successful retry returns the current record, which may have advanced since the original write. Updating records requires `expected_version` from a recent read. Resolve conflicts before retrying.

Actor names are caller-provided coordination identities, not authenticated users. This is a trusted local server, not a multi-tenant service.

```sh
node bin/agentbase.mjs init /absolute/path/to/project
node bin/agentbase.mjs tools
node bin/agentbase.mjs tools checkpoint_save
node bin/agentbase.mjs call task_list '{"project_id":"project_ID","ready_only":true}'
node bin/agentbase.mjs status /absolute/path/to/project
node bin/agentbase.mjs projects import
node bin/agentbase.mjs doctor
```

Use `call <tool> @input.json` or `call <tool> -` to avoid quoting long inputs. `tools <tool>` shows the input schema, including optional fields and defaults.

### Tasks and handoffs

The basic path is `ready → in_progress → review → done`; direct completion from in-progress is also supported. Proposed, blocked, and cancelled work have explicit transitions. Claiming moves ready work to in-progress. Dependencies must be done before claim or completion. Cancelling a dependency does not satisfy it.

Leases coordinate task ownership; they do not lock files or isolate worktrees. The default lease is 30 minutes. Renew it through `task_claim` with the current version. `task_list` with `ready_only` includes expired in-progress/review tasks, marked `reclaimable`, as well as ordinary ready tasks. Reclaim the task before continuing. Completion requires an active lease and, by default, at least one evidence entry. Evidence is **agent-reported**, not independently verified by Agentbase. Reopen completed work with a reason.

Checkpoints capture a source-control fingerprint without storing diffs. Tracked changes, staged changes, and ordinary untracked files are compared. Ignored files are excluded. Fingerprinting is bounded to 100 dirty/untracked files, 2 MiB per file, and 8 MiB total; incomplete or unavailable comparison is reported as unknown. A checkpoint is evidence of the previous state, not proof the checkout is still unchanged.

`project_resume` combines workspace registration and bounded context retrieval in one MCP call. Pass the host's absolute workspace root; use its returned `project.id` for later tools and `project.working_root` for checkout-specific operations. `project_open` and `context_get` remain available separately. When no task ID is given, `project_resume`, `context_get`, and `handoff_get` select the latest unfinished handoff, preferring the requested checkout, or a sole active task. Multiple active tasks without an unfinished handoff are reported as ambiguous. Explicit task selection always wins. Completed/cancelled handoffs do not direct an agent back into finished work. Resume selects the latest relevant checkpoint in SQLite without decoding the full history, and skips Git subprocesses when the workspace has no Git metadata. `handoff_get` reports the full `active_task_count` and previews up to 50 `active_tasks`; use `task_list` for additional tasks when `active_tasks_truncated` is true.

`context_get` prioritizes that selected task, its handoff, related records (including explicit `graph_link` references in either direction), its associated plan, constraints, and ready work. It returns `selected_task_id` and `selection_reason` and includes the selected task's scoped memories. It excludes superseded/forgotten memory and unrelated task-scoped memories. Stale and disputed records remain labelled so an agent can investigate them. `omitted_count` reports all records that did not fit; `omitted_ids` lists up to 50 for `record_get`, and `omitted_ids_truncated` indicates more. Use `search` for additional context. MCP `search` and query-based context rank records matching every query word ahead of partial matches, while retaining partial results for recall. Retrieval uses SQLite FTS5 and links, not embeddings. Character limits are exact for the packet text; token counts are not estimated guarantees.

### Git worktrees and moved projects

`project_open` accepts an absolute directory. Inside Git, it resolves to the checkout root and identifies linked worktrees by their common Git directory. Those checkouts share tasks, memory, data, and a project ID. Separate clones are separate projects even when they have the same remote URL. Non-Git directories remain independent projects.

Pass the returned `working_root` as `root` to `session_start`, `context_get`, `handoff_get`, and `dataset_import` when using a worktree. Without it, Agentbase uses the original registered root, or another available registered root when the original has moved. Sessions bind checkpoints to their own checkout. A handoff from a different checkout is flagged as changed even if its commit matches. File imports are restricted to the selected root, not every worktree attached to the project.

After moving a directory, use `project_list` to locate its existing ID, then call `project_attach` with that ID, the new absolute root, an actor, a new request ID, and a reason. Attach **before** opening the moved path as a new project. Existing project records retain their IDs. Agentbase rejects roots already owned by another project and does not merge projects. It will not attach an unrelated Git repository while the original repository is still available. Dataset snapshots remain intact; historical source paths and repository snapshots remain historical.

### Data analysis

Import files inside the registered root, including through a relative path. Symlinks resolve before the root check. Imports are limited to 50 MiB and copied into the private dataset store. Reimporting a name creates a new dataset version. Subsequent edits to the original file do not change previous analyses.

`analysis_run` maps `dataset_ids` to `d1`, `d2`, and so on. For example:

```sql
SELECT service, sum(errors) AS total_errors
FROM d1
GROUP BY service
ORDER BY total_errors DESC
```

Each worker loads only the selected snapshots into an in-memory DuckDB instance, verifies hashes, disables external access and extension loading, locks its configuration, and accepts exactly one prepared SELECT statement. The parent enforces a 15-second timeout and a 2 MiB output limit; DuckDB is configured for two threads, 256 MiB memory, and 64 MiB spill space. These engine settings are not an OS-wide RSS quota. The Node heap is separately bounded.

The worker runs under macOS sandbox-exec or Linux bubblewrap, with no network and restricted filesystem access. There is no unsandboxed fallback. macOS execution is covered by the local test run; Linux and native dependency packaging require validation on those platforms before declaring support production-ready.

Results contain at most 1,000 saved rows (100 by default), column metadata, hashes, engine version, SQL, and a truncation flag. Big integers and special DuckDB values use lossless JSON representations such as strings. Exports contain these saved rows, not an unlimited result. CSV exports neutralize formula-leading text. `project_export` remains a metadata-only JSON export; use the recovery bundle for a restorable copy with dataset bytes.

## Project state backup and recovery

Version 0.3.0 backs up project records, relationships, audit history, record-write retry receipts, registered dataset snapshots, and saved analysis results. The bundle is a directory containing a JSON manifest, its SHA-256 checksum, and content-addressed dataset files. Identical dataset versions share one copied file. The `agentbase-recover` skill guides the backup and restore workflow.

```sh
node bin/agentbase.mjs backup project_ID /absolute/path/to/new-backup-directory
node bin/agentbase.mjs verify /absolute/path/to/new-backup-directory

# The working directory already exists; the separate Agentbase store may be new.
node bin/agentbase.mjs restore /absolute/path/to/new-backup-directory /absolute/path/to/checkout --home /absolute/path/to/recovery-store
```

The backup destination's parent must exist. Choose a new directory outside the Agentbase data store so the backup survives loss of that store. Existing directories are never overwritten. A completed backup can be recognized on an identical retry even if its database receipt was not saved; an incomplete directory is rejected rather than silently replaced. Keep the bundle intact when copying it elsewhere. The manifest is committed last, after dataset writes, and files are flushed before success is returned.

Restore verifies checksums, file paths, record types, project scope, references, task dependencies, and analysis provenance. It preserves project and record IDs and refuses conflicts with an existing ID, root, or Git repository. Restore into another store when recovering a project that is already registered. Imported records, relationships, search entries, and the restore receipt commit in one SQLite transaction. Failures roll back the import and remove prepared dataset files.

The destination registers only the selected checkout. Dataset paths and session roots are rebound; historical source paths remain historical. Old task leases are cleared, and in-progress/review tasks become ready for a fresh claim. Changed records advance their versions. Checkpoints require verification of the new checkout before work resumes. Record-write retry receipts continue to return current records; filesystem backup/restore receipts are not transferred. Audit event order is retained, while event sequence numbers can change in the destination store.

Repository working files, arbitrary evidence files, account settings, and edited export files are excluded. Restore your repository separately. Saved result exports can be regenerated from the restored analyses. Registered text and data are included as-is, including older knowledge retained in the snapshot: logical forgetting later does not erase an existing backup. The backup is not encrypted or authenticated; checksums detect corruption, not who authored it.

Format version 1 supports SQLite schema version 2, up to 10,000 records, 32 MiB of metadata, 1,000 unique dataset files, and 1 GiB of dataset bytes, with a 50 MiB limit per file. It does not merge projects or overwrite live state. A process killed during restore can leave unreferenced prepared dataset files; retrying uses a new private directory without overwriting them. These filesystem orphans do not register a partial project.

`npm run test:recovery` runs the installed MCP, creates linked work and two datasets, verifies a backup, deletes the original store and working files, and recovers into a separate store. It checks search, retry protection, lease reset, analysis reproduction, evidence-backed completion, and restart persistence. Test stores are removed; the report is saved under `test-results/recovery/`.

These tests exercise the real installed MCP and Codex host without model calls; they do not establish cross-platform compatibility or model behavior.

## Storage and privacy

Default state: `~/.local/share/agentbase`. Set `AGENTBASE_HOME` or pass `--home /directory` to use an isolated store. SQLite uses WAL, foreign keys, a busy timeout, and immediate write transactions. Each MCP process connects directly to that shared local SQLite store; no resident daemon is required. DuckDB workers use independent in-memory databases, avoiding shared writable DuckDB files.

Version 0.2.1 retries transient SQLite lock errors during initialization. This covers simultaneous first opens, where setting WAL mode can fail immediately despite the ordinary busy timeout. Retries are bounded and limited to initialization; arbitrary work mutations are not automatically replayed.

The database upgrades schema version 1 to version 2 transactionally on startup, preserving records, search, and request receipts. Restart MCP processes after upgrading; older releases cannot open the new schema. Unsupported newer schema versions are rejected without creating application tables. Legacy projects gain Git identity when reopened. If several legacy projects match one repository, Agentbase reports ambiguity rather than merging their data. Keep the data directory on local storage rather than a network filesystem.

Agentbase does not intentionally transmit project data or invoke a model provider. Information returned through MCP is available to the connected host and its configured model. Do not record secrets. `memory_update` with `forgotten` removes the record's normal content and search entry; audit events retain metadata rather than copies of its text. This is logical deletion, not secure disk erasure. Separately copied text in checkpoints, exports, backups, or host conversations is not automatically erased.

## Validation and next steps

`npm test` exercises the real stdio protocol, fresh-session recovery, automatic task selection and ambiguity, separate-process claim races, version conflicts, lease recovery, dependency rollback, project boundaries, Git worktrees, moved directories, database migration, memory correction, bounded context, repository changes, sandboxed ingestion and SQL, immutable datasets, result exports, query timeouts, and the diagnostic command.

`npm run test:package` builds and packs an archive, extracts it into a temporary directory, then launches that copy through MCP and runs a sandboxed data query. It checks that the packaged runtime works independently of the development checkout.

`npm run test:projects` exercises a seven-task release through the installed MCP using three independent clients. It covers plans and revisions, dependency cycles, competing claims, lease renewal and real expiry, ownership enforcement, blockers, reopening, evidence, restart recovery, project isolation, pagination, and audit relationships. It uses an isolated store and synthetic evidence; reports are written to `test-results/project-management/` and test state is removed afterward. Pass `-- --output=path` to keep a separate run.

Version 0.2.3 includes dependency IDs, blocker titles/statuses, and lease state in task reads and resume packets. These fields are derived from current project state, so reopening or completing a prerequisite updates the explanation returned to the next agent.

The current scope is an MCP alpha. Next work: broader Codex pilot sessions and capture evaluations, Linux/Windows packaging validation, further retrieval tuning, and then Claude adapters. Remote ChatGPT access is deferred; the native macOS inspector is available. There is no web implementation.

## Package locally

```sh
npm pack
```

The npm archive bundles runtime dependencies, compiled output, manifests, and skills. Native DuckDB dependencies are specific to the platform used to install/build the archive. It is not a universal desktop plugin ZIP. Nothing is published by this command. Review the archive and validate a clean install on each target platform before distribution.

## License

Apache-2.0. See [LICENSE](LICENSE).
