# Hive agent access

Presentail Hive agents can hand coding tasks to Claude Code in this repository via
`.github/workflows/claude-task.yml` (manual `workflow_dispatch` only). Claude Code opens a
pull request against `main`; it never merges or publishes anything — a person reviews and merges.

This file was added by a smoke test verifying the workflow, its `ANTHROPIC_API_KEY` secret and
pull-request creation. It is safe to delete.
