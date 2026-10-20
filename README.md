# Just Enough Quota Bar

A VS Code extension that shows your **Claude Code** and **Codex** subscription quota windows in the status bar. Nothing more.

> **Status:** work in progress. This repository currently contains the project foundation and the quality pipeline. The features below are planned, not implemented yet.

## What it will do

- Show the 5-hour and weekly quota windows (usage and reset time) for Claude and Codex.
- Show the redeemable (banked) resets and the next announced global reset.
- Let you choose the displayed text with a per-provider format string, and colour each variable with its own thresholds.

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
