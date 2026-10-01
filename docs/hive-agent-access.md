# Hive agent access

## Workflow verification 2026-09-30

- `.github/workflows/claude-task.yml` and `.github/workflows/ci.yml` now use a bare `pnpm/action-setup@v4` with no `version:` input, because `package.json` pins `"packageManager": "pnpm@10.26.1"` and passing both causes `ERR_PNPM_BAD_PM_VERSION`.
- `cache: pnpm` was removed from the `actions/setup-node@v4` step in `claude-task.yml`, because that job does not run `pnpm install`, so the cache-save post step failed with "Path Validation Error: Path(s) specified in the action for caching do(es) not exist" and made every run show red.
- The Hive `os` code-repository row's token now holds Actions: write, Issues: write and Pull requests: write.
