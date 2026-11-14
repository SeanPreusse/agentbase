---
name: agentbase-local-iteration
description: Make AgentBase project changes across multiple chats using the local app for testing, and bundle them into an installer only when the user requests a release.
---

For ordinary AgentBase implementation requests, make the requested change and run checks that fit its scope. Use the local macOS app (`npm run ui:build` or `npm run ui`) when the inspector UI changes; use focused tests for the changed behavior. Keep the working tree and AgentBase task state ready for the next chat.

Treat packaging as a separate release step. Do not bump the version, refresh the installed Codex plugin, or run `release:mac` for each small request. When the user asks to bundle a release, review the accumulated changes, run the relevant full checks, choose one version update, refresh the plugin, and create the Mac package. Report what was tested locally and what is still awaiting a release build.

The user's current request can override this workflow, including a request for an immediate package or a narrower test.
