---
name: codex-workspace-enhancer
description: Audit, install, adapt, or extend Codex Workspace Enhancer. Prefer the native Codex plugin and fullscreen MCP App for a port-free visual asset canvas; use the legacy sidebar/AssetBrowser adapters only for features the plugin does not yet provide. Use for native Codex widgets, visual workspace UI, image canvases, task recall, local asset management, safe installation, rollback, or platform adaptation.
---

# Codex Workspace Enhancer

Turn Codex into a continuous task-and-asset workspace without patching, modifying, or re-signing the Codex application. The primary adapter is the native plugin under `plugin/codex-workspace-enhancer/`: a composer icon opens a fullscreen MCP App over stdio, with no localhost page. Keep the legacy Windows/macOS runtime as a compatibility adapter, not as the product definition.

## Route the request

1. Route native visual workspace requests to `plugin/codex-workspace-enhancer/` first. Read `references/native-plugin.md`.
2. Inspect the current platform only for legacy install, repair, or compatibility work:
   - **macOS:** run `node scripts/inspect-macos.mjs`.
   - **Windows:** run `scripts/inspect.ps1`.
3. Choose one scope:
   - **Audit/UI:** inspect native structure first; read `references/interaction-model.md` and `references/acceptance-checklist.md`.
   - **Install/update:** always run the platform dry-run first, review exact owned roots, then activate.
   - **Port/adapt:** read `references/architecture.md` and `references/adapter-contract.md`; replace only the platform adapter.
4. Preserve user data and native Codex controls. A plugin may own its fullscreen widget layout, but must not claim it can mutate Codex's outer sidebar or chrome.
5. Run the matching verifier after any change. Treat failed safety, MCP probe, widget QA, or task-context checks as blockers.

## Non-negotiable behavior

- Keep fixed shortcuts and tabs in normal layout flow; scrolling content must begin below them with no visual cover layer.
- Synchronize the weekly usage display from the latest valid Codex rate-limit event. Never fabricate a percentage.
- Open the visual workspace as a native Codex MCP App. Do not launch a second visible app window or localhost page.
- Refresh the embedded task context when the active task changes; invalidate the old iframe/session.
- Return selected assets to the current composer as absolute local paths only. Never submit or send automatically.
- Support folder navigation, create, rename, move, undo, and project-level automatic organization.
- Keep destructive actions secondary and explicit. "Discard" must not imply deleting source files.
- Use bounded caches, lazy media loading, request generations, reduced-motion-safe busy states, and stale-response guards.
- Do not require a proxy for native-plugin features. If a legacy adapter is explicitly used, restrict proxy access to the dedicated asset frame/session and tear it down on close.
- Preserve configuration, ledgers, projects, and assets across install/update/rollback.

## Bundled Windows reference

The skill includes a reviewed snapshot of the sidebar enhancer and its local AssetBrowser service under `assets/runtime/`. It contains no personal project configuration, media, task history, or credentials.

Install or update the reference implementation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-bundled.ps1 -WhatIf
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-bundled.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
```

The installer only owns `%LOCALAPPDATA%\Programs\Codex Sidebar Enhancer`, `%LOCALAPPDATA%\CodexSidebarEnhancer`, and known runtime files under `%LOCALAPPDATA%\AssetBrowser`. It preserves `asset-browser.config.json`, ledgers, and all project folders.

## Bundled macOS adapter

The unpacked, reviewed runtime lives at `assets/runtime/enhancer/`; the local AssetBrowser service lives at `assets/runtime/asset-browser/`. On macOS, inspect and preview before activating:

```bash
node scripts/inspect-macos.mjs
node scripts/build-macos-manifest.mjs
node scripts/verify-macos.mjs
node scripts/install-bundled-macos.mjs --dry-run
node scripts/install-bundled-macos.mjs --activate
node scripts/verify-macos.mjs --installed
```

The macOS adapter owns only these product locations:

- `~/Library/Application Support/Codex Sidebar Enhancer`
- `~/Library/Application Support/CodexSidebarEnhancer`
- known runtime files under `~/Library/Application Support/AssetBrowser`
- `~/Library/LaunchAgents/com.yubowen.codex-sidebar-enhancer.plist`
- `~/Library/Logs/CodexSidebarEnhancer`
- `~/Applications/Codex Sidebar Enhancer.app`

It never modifies `/Applications/ChatGPT.app` or `/Applications/Codex.app`, and installation never quits, opens, or restarts either app. The launcher supplies the local-only debug arguments only after the user has normally quit the running app. AssetBrowser configuration, API token, ledgers, projects, media, quarantines, prompt library, and creative delivery folders are preserved across updates.

## Native Codex plugin (preferred)

The canonical source is `plugin/codex-workspace-enhancer/`. It contributes:

- `interface.composerIcon` for the native plugin/composer entry.
- A stdio MCP server with no listening socket.
- `ui://widget/visual-workspace/canvas.html` as a sandboxed MCP App resource.
- `inline` and `fullscreen` display modes, defaulting to fullscreen.
- A bounded, read-only project image scan and user-level revisioned canvas state.

Quality gate:

```bash
cd plugin/codex-workspace-enhancer
npm run quality
npm run verify:widget
uv run --with pyyaml python ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

`npm run quality` rebuilds and probes the standalone `dist/server.mjs` release from a temporary plugin copy without `node_modules`. Keep `.mcp.json` pointed at that release artifact so Git Marketplace installation does not depend on an unverified package-install lifecycle.

Installation must use the personal plugin marketplace and `codex plugin add`; it must not modify or re-sign the Codex app. Open a new Codex task after install so the host loads the new skill, MCP tools, and composer icon.

## Adapt instead of forking the method

Keep the stable workflow and acceptance rules unchanged. Implement platform differences behind the adapter contract: Codex discovery, debug transport, local-service lifecycle, shortcut creation, safe install roots, and absolute-path validation. If a required adapter capability is missing, fail closed and report the missing capability.

## Final checks

- Run deterministic syntax and package checks before visual review.
- Verify source, packaged runtime, and installed runtime hashes when claiming consistency.
- Exercise task A -> task B with Asset Console open.
- Exercise rapid folder A -> B switching with reversed response order.
- Confirm no automatic message send and no deletion outside owned paths.
- For a deliverable change, request a fresh independent cold review after tests pass.
