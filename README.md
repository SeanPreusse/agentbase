# AgentBase

**Open-source project state for coding agents.**

AgentBase stores tasks, decisions, sources, and handoffs in a local project database. Codex and Claude Code retrieve project context through MCP; the macOS app lets you inspect the graph and task board.

## See it in action

![AgentBase title card followed by live Graph and Tasks views of the same import-reliability demo project](docs/screenshots/showcase.gif)

[Graph](docs/screenshots/graph.png) · [Tasks](docs/screenshots/kanban.png)

## What it does

- Stores sourced knowledge, decisions, tasks, plans, and handoffs in a local project database.
- Uses DuckDB to run sandboxed SQL over imported CSV, JSON, JSONL, and Parquet data; saved analyses keep their query, bounded results, and provenance.
- Backs up project records and imported dataset files together.
- Helps agents find relevant past work and continue it across sessions, with a native macOS inspector for the graph and task board.
- Offers to turn a substantive implementation plan into linked AgentBase tasks. After you accept, the `plan_tasks_create` MCP tool creates one task per selected milestone in a single idempotent operation.
- Lets you review memory and decision nodes in Graph. You can compare possible duplicates, inspect sources and validity dates, then approve, correct, supersede, mark stale or disputed, reject, or forget a record. Review actions use version checks and appear in the record's recent changes.

AgentBase does not call a model or send project data to a hosted service. The MCP server and project store run locally.

`context_get` and `project_resume` rank context by the current query, task links and scope, memory status, and freshness. They keep the packet within its character budget, collapse exact duplicate memory text, and return reasons for included records and a bounded preview of omissions. Keyword search stays local and works without embeddings or a model service.

Use the `mcp_status` tool to check server and storage readiness. For a sandboxed analysis check, run `agentbase doctor`.

## Memory quality checks

Run `npm run eval:memory:deterministic` for an isolated retrieval, lifecycle, context-budget, and handoff baseline. Run `npm run eval:memory` for the Codex model scenario or `npm run eval:memory:claude` for the same synthetic invoice-import scenario in Claude Code. The model scenarios use separate temporary project stores and write reports under `test-results/`; they make model calls and are not reliability benchmarks. Each report separates checks from model usage and phase errors.

## Quick start

Requires Node.js 22.22 or newer and Codex or Claude Code.

```sh
git clone https://github.com/SeanPreusse/agentbase.git
cd agentbase
npm ci
npm run plugin:up
```

Start a fresh Codex session to load the plugin. `npm run ui` builds and opens the macOS inspector on macOS 14 or newer; it checks available Codex and Claude Code connections on launch. Start a new host session after setup.

## Shared memory, privacy, and recovery

Codex and Claude Code share AgentBase projects when both MCP servers point to the same data directory. The default is `~/.local/share/agentbase`; `AGENTBASE_HOME` or `--home <directory>` can select another. The inspector's **Connections → Shared memory and data control** shows the folder it has opened. If you change that folder, configure both hosts to use the same path and reconnect them. The Claude Code install action uses the inspector's current folder. A Codex plugin uses the default folder or `AGENTBASE_HOME` supplied to its server process; for a custom path, configure its MCP server with `--home` (run `agentbase config --home <directory>` for a local config example). An installed plugin does not inherit the inspector's folder selection automatically.

Connections reads each host's MCP command to show its configured data path and flags a path that differs from the inspector. A default path inferred from the command is labeled **likely default**; a path inherited from the host environment or an unreadable configuration is **unconfirmed**. Tool readiness alone does not prove that both hosts share data.

In either host, ask to resume the current workspace, save a sourced memory, or review pending memories. These use the same MCP project records. Memory capture requires an explicit tool call; AgentBase does not install session hooks or silently collect conversations. New memory records are marked pending until reviewed from their Graph node. AgentBase retains records without a timed expiry; select a memory or decision node in Graph to reject, supersede, or forget it. Forgetting does not erase copies already made in exports or backups.

The SQLite store and imported dataset snapshots stay under the selected data directory. AgentBase applies restricted local file permissions, but does not provide application-level encryption. Use an encrypted volume if encryption at rest is required. Project backups are readable files; choose a protected destination and handle them as project data. AgentBase makes no automatic backups.

To move one project to another AgentBase store, create a backup in a **new directory outside the data folder**, verify it, then restore it into an existing, unregistered checkout directory:

```sh
agentbase backup <project-id> <new-backup-directory>
agentbase verify <backup-directory>
agentbase restore <backup-directory> <checkout-directory> --home <new-data-directory>
```

The backup includes records, links, audit history, saved analysis, and imported dataset bytes. It excludes repository working files. Restore preserves record IDs, resets active task leases, and refuses an existing project ID or root in the destination store. Keep your checkout or restore it separately before running `agentbase restore`.

## Contribute

AgentBase is open source under the Apache-2.0 license, and contributions are welcome. Open an issue to report a bug or discuss an idea; pull requests for code, docs, tests, and design are welcome too.

To get started, install Node.js 22.22+, run `npm ci`, make a focused change, and run `npm test`. Run `npm run test:mcp` for the real stdio compatibility check. For inspector changes on macOS, run `npm run test:ui` as well. Please describe the problem your change solves and what you checked.

## License

Apache-2.0. See [LICENSE](LICENSE).
