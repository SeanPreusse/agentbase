---
name: agentbase-recover
description: Back up, verify, or restore Agentbase project state, including memory, plans, tasks, handoffs, datasets, and saved analyses, when the user requests backup or recovery. Ordinary task continuation uses agentbase-resume.
---

Use the Agentbase MCP tools within the user's requested backup or recovery scope. If the connection is unavailable, explain that nothing was backed up or restored.

For backup, find the project with `project_open` or `project_list`, then call `project_backup` with a new absolute destination directory outside the Agentbase data store. Its parent must exist. Supply a distinctive actor and a new request ID. Retry only with the identical ID and arguments. Run `backup_verify` on the returned path before describing the backup as verified.

The bundle contains Agentbase state and registered dataset snapshots, including recorded text and data as-is. It does not back up repository working files, account settings, or arbitrary files referenced by evidence. Saved result exports can be regenerated from restored analyses. Keep the bundle private because it contains project records and data. Checksums detect corruption; they do not prove who authored a backup.

For restore, verify the specified backup, identify the intended existing working directory and destination store, and call `project_restore`. A restore preserves project and record IDs and refuses to overwrite an existing project, registered directory, or Git repository. If a conflict is returned, keep the existing state intact and resolve the destination with the user. Do not delete or merge projects to bypass a conflict.

Restored task leases are cleared; unfinished in-progress/review work becomes ready and needs a new claim. Dataset and session paths bind to the destination; checkpoints require re-verification of the current checkout. Historical source/evidence paths remain historical. Do not claim that files referenced by those paths were restored.

After restore, use the returned project ID and working root with `context_get`. Check the relevant tasks, search, and saved analyses before resuming work. Record-write retry receipts survive recovery; old filesystem backup/restore receipts do not. Use a fresh ID for a new recovery operation. Describe the actual recovered scope and any unavailable working files.
