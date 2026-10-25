# Just Enough Quota Bar

A VS Code extension that shows your **Claude Code** and **Codex** subscription quota windows in the status bar. Nothing more.

> **Status:** work in progress. This repository currently contains the project foundation and the quality pipeline. The features below are planned, not implemented yet.

## What it will do

- Show the 5-hour and weekly quota windows (usage and reset time) for Claude and Codex.
- Show the redeemable (banked) resets and the next announced global reset.
- Let you choose the displayed text with a per-provider format string, and colour each variable with its own thresholds.

## Codex source

`jeqb.codex.source` chooses where the Codex quota comes from:

- `auto` (default): `codex app-server` when the `codex` binary is found (`jeqb.codex.binaryPath`, otherwise `PATH`), the probe when it is not. A failing app-server does not switch to the probe.
- `appServer`: always the official `codex app-server`. It uses no quota.
- `probe`: always the probe.

**The probe uses a small amount of quota.** It reads the token of `$CODEX_HOME/auth.json` (or `~/.codex/auth.json`), lists the models, sends a minimal streamed `responses` request ("reply ok") and reads the limits from its `x-codex-*` response headers, then asks the reset credits. Because every run counts against your quota, it is only the fallback for a machine without the `codex` binary and runs at most every 10 minutes: `jeqb.codex.probeIntervalMinutes` defaults to 10, and a smaller value is raised to 10. The machine-wide cache keeps several VS Code windows from multiplying the requests.

The probe uses undocumented endpoints on `chatgpt.com`. If their format changes, the extension shows an error code (for example `invalid_quota_headers`) instead of failing. The token is only read, never written, cached or logged.

## Out of scope

This extension deliberately does **not** provide:

- history, charts, consumption or usage analytics, pace or forecasts;
- alerts or notifications;
- dashboards or webviews;
- redeeming resets or any other write action;
- other providers, or multiple accounts per provider.

## Design

The full plan and specification live in the project's Backlog document *Just Enough Quota Bar – terv és specifikáció* (`doc-1`). The market analysis behind it is `versenytarsak-riport.md` in the project root.

## Development

Requirements: Node.js, [Task](https://taskfile.dev) and, on Linux, `xvfb` for the integration test.

```sh
task verify
```

`task verify` runs ESLint, the TypeScript type check, the Vitest unit tests (≥ 80 % branch coverage), the `@vscode/test-electron` integration test and the `vsce package` check. The same command runs in GitHub Actions on Linux, macOS and Windows.

## License

[MIT](LICENSE)
