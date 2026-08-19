# Visual Workspace native Codex plugin

Visual Workspace is the preferred Codex Workspace Enhancer surface. It opens a sandboxed MCP App inside the current Codex conversation, requests host-negotiated fullscreen, and remains usable inline.

## Included behavior

- Composer icon and plugin prompt entry
- Standalone bundled stdio MCP server (`dist/server.mjs`)
- Direct reopening for approved exact paths and validated worktrees from the same Git repository
- One-time exact-path in-widget approval when host roots are unavailable
- Durable, atomically single-use pending approvals across MCP server restarts
- Session-scoped capability with teardown revocation and bounded expiry
- Bounded, read-only project image scan and preview
- Infinite pan/zoom canvas, notes, resize, and multi-selection
- Revisioned atomic user-level canvas persistence
- Structured selection handoff without automatically sending a message
- One-shot, internally consistent display-mode diagnostic receipt

The plugin does not patch, modify, or re-sign Codex, does not replace host-owned chrome, and does not use a localhost HTTP server. Fullscreen is a host capability, not a plugin guarantee.

## Build and quality gate

```bash
npm ci
npx playwright install chromium
npm run quality
uv run --with pyyaml python ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

`npm run quality` builds and probes the standalone release from a temporary copy with no `node_modules`, then runs Playwright interaction and visual QA in light, dark, inline, reduced-motion, consent, conflict, teardown, XSS, gesture, and preview-concurrency states.

Generated screenshots and the machine-readable QA report are written under `artifacts/`. Bundled npm notices are written to `dist/THIRD_PARTY_LICENSES.txt`.

For GitHub installation, architecture, security boundaries, and limitations, see the [repository README](../../README.md) and [native plugin architecture](../../references/native-plugin.md).
