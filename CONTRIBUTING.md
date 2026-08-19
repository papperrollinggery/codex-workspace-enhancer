# Contributing

Focused bug fixes, security hardening, accessibility improvements, and host-compatibility updates are welcome.

## Setup

```bash
npm run setup
npm run quality
```

Node.js 20 or newer is required for the native plugin; optional legacy-adapter development requires Node.js 22 or newer. Browser QA reuses `CHROME_PATH` or the standard macOS Chrome location when available; otherwise install Playwright Chromium with `npx playwright install chromium`.

## Change rules

- Keep the native plugin port-free and do not patch or re-sign the Codex application.
- Treat fullscreen as host-negotiated and preserve a usable inline layout.
- Never auto-send messages, delete source images, or widen project access without an explicit user action.
- Keep path checks realpath-based and fail closed on symbolic links or ambiguous ownership.
- Add a regression test for bug fixes when practical.
- Do not commit `node_modules`, local state, tokens, project assets, or DeepSeek collaboration files.
- Rebuild and commit `plugin/codex-workspace-enhancer/dist/` when native server dependencies or source change.
- Rebuild and commit the deterministic legacy Windows archive with `npm run build:windows-bundle` whenever a listed enhancer payload changes.
- A Dependabot dependency PR is expected to fail the generated-release gate until a maintainer rebuilds and commits `dist/`; do not bypass that gate.

## Pull requests

Describe the user impact, security implications, validation commands, and any host behavior that remains unverified. A passing source test does not prove a specific Codex host granted fullscreen or loaded a new plugin snapshot.
