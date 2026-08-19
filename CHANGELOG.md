# Changelog

All notable public changes are documented here. Versions follow Semantic Versioning for the native plugin.

## [0.2.0] - 2026-08-19

### Added

- Standalone bundled MCP server and a release probe that runs from a plugin copy without `node_modules`.
- Git Marketplace catalog, CI, Dependabot, security policy, contribution guide, root/plugin licenses, third-party notices, bilingual README, `llms.txt`, and `CITATION.cff`.
- Regression coverage for unreadable project folders, immutable display receipts, and selection handoff without automatic message submission.

### Changed

- Updated MCP Apps, MCP TypeScript SDK, Playwright, and Zod-compatible lock data to current verified versions.
- Made browser QA portable by removing user-specific runtime paths and reusing an installed Chrome when available.
- Selection handoff now updates structured conversation context and waits for the user to send the next instruction.
- Display receipts are one-shot diagnostics: identical retries are idempotent, while contradictory overwrites are rejected.

### Fixed

- Project scans now degrade safely when a nested directory becomes unreadable or disappears.
- Public plugin metadata no longer uses the `Local workspace` placeholder.
