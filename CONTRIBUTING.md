# Contributing

Use Node 24.15 or newer. Run `npm ci`, `npm run check`, and `npm test`. Keep MCP stdout exclusively for protocol messages; use stderr for diagnostics.

For local Codex development use `npm run plugin:down`, edit the source, then `npm run plugin:up`. Reconnect the Codex session after installing so it loads the refreshed cache. `npm run plugin:status` verifies cache freshness; `npm run test:installed` exercises the installed plugin through both independent MCP clients and Codex's app-server without model calls. The development commands back up config before changing Agentbase's enabled state and do not remove project data.

The application service is in `src/service.ts`, schemas in `src/schemas.ts`, SQLite persistence in `src/store.ts`, and the MCP adapter in `src/server.ts`. Skills describe agent behaviour rather than implementing storage rules. Future interfaces should call the service through an appropriate local adapter.

For changes to persistent state, preserve project scoping, version checks, atomic writes, and request idempotency. For schema changes, introduce an explicit migration and recovery test before advancing the schema version. Do not weaken the analysis sandbox or add an unsandboxed fallback to make tests pass.

Add behavioural coverage for changed invariants. Use temporary stores and files; do not depend on the contributor's Codex account, API keys, or personal data. Exercise transport changes with the actual MCP client.

No hosted service, telemetry, external messaging, or model calls should be introduced implicitly. Discuss changes to data collection, portability, and runtime requirements in the proposed change.
