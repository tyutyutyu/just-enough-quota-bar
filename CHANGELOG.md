# Changelog

All notable changes of Just Enough Quota Bar are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- A server `Retry-After` is honored for at most 24 hours, so a malformed or hostile answer can no longer silence a source for longer than a day.

## [0.0.1]

The first release on the Visual Studio Marketplace and Open VSX.

### Added

- Claude and Codex quota in the status bar: the 5-hour and the weekly window, used share and reset time.
- Redeemable (banked) resets: count and earliest expiry.
- Next announced global reset from whenreset.app or, for Codex, codex-reset.com, credited and linked in the tooltip.
- Python-like format string per provider (`jeqb.claude.format`, `jeqb.codex.format`) with number, time and text specs.
- Thresholds per variable (`jeqb.thresholds`, overridable per provider); every coloured variable is its own status bar item.
- Claude source: Claude Code OAuth token from `.credentials.json` or the macOS Keychain, read only.
- Codex source: the official `codex app-server`, with the quota-using probe as the fallback when the `codex` binary is missing (`jeqb.codex.source`).
- Machine-wide shared cache with a lock per source, so several VS Code windows share one refresh; stale data and backoff after failures.
- **Just Enough Quota Bar: Refresh quota** command, also on click.

[Unreleased]: https://github.com/tyutyutyu/just-enough-quota-bar/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/tyutyutyu/just-enough-quota-bar/releases/tag/v0.0.1
