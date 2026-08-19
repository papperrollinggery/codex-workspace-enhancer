# Changelog

All notable public changes are documented here. Versions follow Semantic Versioning for the native plugin.

## [0.2.1] - 2026-08-19

### Fixed

- Fail closed instead of claiming a selection was attached when the Codex host lacks model-context support.
- Preserve bounded scanning when a directory disappears or becomes unreadable during iteration, and enforce the 20,000-entry cap globally.
- Prevent an operation-level `EEXIST` from being misclassified as file-lock contention and retried.
- Pin the MCP Apps package whose internal browser-bundle footer is parsed during release builds.
- Rebuild the legacy Windows ZIP deterministically from adjacent source and verify all 36 archive entries for byte equality.
- Replace unreproducible legacy verification numbers with repository-runnable checks.
- Reuse GitHub's preinstalled Chrome for browser QA instead of downloading a duplicate Playwright browser on every CI run.

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
- Fresh Git checkouts preserve manifest-hashed PowerShell bytes across operating systems.
- CI uses the current Node 24-based major versions of official GitHub Actions.
