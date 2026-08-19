# macOS Codex Workspace Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a visible, usable, extensible macOS right-side workspace panel to the current Codex Workspace Enhancer without replacing or weakening the native Visual Workspace plugin.

**Architecture:** Keep the `0.2.2` MCP App as the authority for project approval, asset reads, board revisions, and model-context handoff. Modernize the existing CDP-injected tool rail as an optional panel shell, connect it to a dedicated stdio client for the installed native MCP server, and expose a compact dock that shares the native workspace session rather than storing a second canvas. Add PiP as an official MCP Apps display mode and keep inline/fullscreen as fallbacks.

**Tech Stack:** Node.js ESM, MCP JSON-RPC over stdio, MCP Apps `2026-01-26`, Playwright, Chrome DevTools Protocol, macOS LaunchAgent/app launcher, Git worktrees, native JSON state.

---

## File Map

**Native plugin**

- Modify `plugin/codex-workspace-enhancer/mcp/server.mjs`: accept and report `pip` display mode.
- Modify `plugin/codex-workspace-enhancer/mcp/lib/widget-resource.mjs`: advertise PiP capability.
- Modify `plugin/codex-workspace-enhancer/widget/index.html`: add explicit PiP control.
- Modify `plugin/codex-workspace-enhancer/widget/app.js`: negotiate dock/PiP/fullscreen without confusing requested and actual modes.
- Modify `plugin/codex-workspace-enhancer/scripts/probe-mcp.mjs`: protocol coverage for PiP.
- Modify `plugin/codex-workspace-enhancer/scripts/verify-widget.mjs`: visual and interaction coverage for PiP controls.

**Panel bridge**

- Create `assets/runtime/enhancer/lib/mcp-stdio-client.mjs`: bounded JSON-RPC stdio client.
- Create `assets/runtime/enhancer/lib/native-workspace-client.mjs`: open/reuse approved native workspace sessions and call native app-only tools.
- Create `assets/runtime/enhancer/lib/panel-context.mjs`: resolve current thread, cwd, project, branch, worktree, and plugin path.
- Create `assets/runtime/enhancer/lib/panel-module-registry.mjs`: static trusted panel module registry.
- Create `assets/runtime/enhancer/panel/public/index.html`: compact panel shell.
- Create `assets/runtime/enhancer/panel/public/panel.js`: overview/assets/canvas/tasks/changes/tools modules.
- Create `assets/runtime/enhancer/panel/public/panel.css`: responsive dock styling.

**Injector and lifecycle**

- Modify `assets/runtime/enhancer/scripts/injector.mjs`: serve panel static/API routes through the existing private CDP frame proxy and manage native MCP sessions.
- Modify `assets/runtime/enhancer/inject/conversation-preview.user.js`: modern tool rail, dock shell, focus management, module activation, native route actions, complete teardown.
- Modify `assets/runtime/enhancer/lib/asset-console-embed.mjs`: separate private panel prefix and route allowlist.
- Modify `assets/runtime/enhancer/lib/preview-data.mjs`: include thread cwd and state classification.
- Modify `assets/runtime/enhancer/lib/install-config.mjs`: include panel files and runtime metadata.
- Modify `assets/runtime/enhancer/scripts/install-macos.mjs`: install and preserve panel runtime.
- Modify `assets/runtime/enhancer/scripts/verify-macos.mjs`: verify installed hashes and optional launch state with correct CLI flags.

**Tests and docs**

- Create `assets/runtime/enhancer/test/mcp-stdio-client.test.mjs`.
- Create `assets/runtime/enhancer/test/fixtures/fake-mcp-server.mjs`.
- Create `assets/runtime/enhancer/test/native-workspace-client.test.mjs`.
- Create `assets/runtime/enhancer/test/panel-context.test.mjs`.
- Create `assets/runtime/enhancer/test/panel-module-registry.test.mjs`.
- Create `assets/runtime/enhancer/test/panel-bridge-security.test.mjs`.
- Modify `assets/runtime/enhancer/test/native-right-rail.test.mjs`.
- Modify `assets/runtime/enhancer/scripts/verify-native-right-rail.mjs`.
- Modify `README.md`, `README.zh-CN.md`, `references/macos-adapter.md`, `CHANGELOG.md`.

## Task 1: Add MCP Apps PiP Support

**Files:** native plugin files listed above.

- [ ] **Step 1: Write failing protocol assertions**

Add to `scripts/probe-mcp.mjs`:

```js
const pipOpen = await client.callTool({
  name: "open_visual_workspace",
  arguments: { projectDir, displayMode: "pip" },
});
if (pipOpen.structuredContent?.preferredDisplayMode !== "pip") {
  throw new Error("Visual Workspace did not preserve a PiP request");
}
```

Add a bridge-source assertion to `test/widget-resource.test.mjs`:

```js
assert.match(widget, /availableDisplayModes: \["inline", "fullscreen", "pip"\]/u);
```

- [ ] **Step 2: Run the tests and confirm RED**

Run:

```bash
npm --prefix plugin/codex-workspace-enhancer test
npm --prefix plugin/codex-workspace-enhancer run probe:mcp
```

Expected: widget-resource and MCP probe fail because PiP is rejected or not advertised.

- [ ] **Step 3: Implement PiP schemas and capability declaration**

Use one shared mode list in `server.mjs`:

```js
const DISPLAY_MODES = ["fullscreen", "inline", "pip"];
const displayModeSchema = z.enum(DISPLAY_MODES);
```

Change the bridge declaration:

```js
{ availableDisplayModes: ["inline", "fullscreen", "pip"] }
```

Update `normalizeDisplayMode()` to accept PiP and add `#togglePip`:

```js
function normalizeDisplayMode(value) {
  return ["fullscreen", "inline", "pip"].includes(value) ? value : "";
}

elements.togglePip.addEventListener("click", () => {
  void requestDisplayMode("pip", { announce: true });
});
```

- [ ] **Step 4: Run targeted checks and commit**

Run:

```bash
npm --prefix plugin/codex-workspace-enhancer run check
npm --prefix plugin/codex-workspace-enhancer test
npm --prefix plugin/codex-workspace-enhancer run probe:mcp
npm --prefix plugin/codex-workspace-enhancer run verify:widget
```

Expected: PASS, with PiP request recorded independently from actual host mode.

Commit:

```bash
git add plugin/codex-workspace-enhancer
git commit -m "feat: add Visual Workspace PiP mode"
```

## Task 2: Build a Bounded MCP Stdio Client

**Files:** `mcp-stdio-client.mjs` and test.

- [ ] **Step 1: Write failing lifecycle tests**

Test a fake JSONL child that answers initialize and tools/call:

```js
const client = new McpStdioClient({ command: process.execPath, args: [fixtureServer] });
await client.connect();
assert.equal((await client.callTool("echo", { value: 7 })).structuredContent.value, 7);
await client.close();
assert.equal(client.state, "closed");
```

Create `test/fixtures/fake-mcp-server.mjs` with a complete deterministic fixture:

```js
import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } },
    })}\n`);
  } else if (request.method === "tools/call") {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [{ type: "text", text: "ok" }], structuredContent: request.params.arguments },
    })}\n`);
  }
});
```

Also assert: 1 MiB line cap, 10-second timeout, unknown response id ignored, child exit rejects pending calls, stderr never enters JSON parser.

- [ ] **Step 2: Run RED**

```bash
node --test assets/runtime/enhancer/test/mcp-stdio-client.test.mjs
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the client**

Expose:

```js
export class McpStdioClient {
  constructor({ command, args, cwd, env, timeoutMs = 10_000, maxLineBytes = 1024 * 1024 }) {}
  async connect() {}
  async callTool(name, arguments_) {}
  async close() {}
}
```

Use newline-delimited JSON, monotonically increasing numeric IDs, a `Map` of pending requests, and explicit initialize/initialized handshake. Never invoke a shell.

- [ ] **Step 4: Verify and commit**

```bash
node --test assets/runtime/enhancer/test/mcp-stdio-client.test.mjs
git add assets/runtime/enhancer/lib/mcp-stdio-client.mjs assets/runtime/enhancer/test/mcp-stdio-client.test.mjs
git commit -m "feat: add bounded MCP stdio client"
```

## Task 3: Reuse the Native Workspace Server

**Files:** `native-workspace-client.mjs`, `panel-context.mjs`, tests.

- [ ] **Step 1: Write failing approved/unapproved tests**

```js
const workspace = await client.openApprovedWorkspace({ projectDir, displayMode: "inline" });
assert.equal(workspace.accessState, "approved");
assert.equal(workspace.authorizationSource, "previous-approval");
assert.ok(workspace.workspaceId);
assert.ok(workspace.accessToken);
```

For an unapproved fixture, assert `confirmation_required` is returned without calling the app-only approval tool.

- [ ] **Step 2: Implement installed-server discovery**

Accept an explicit server path first. Otherwise inspect installed plugin rows and cache roots, require version `>=0.2.2`, require regular files, reject symlinks, and verify `plugin.json` name.

Expose:

```js
export async function discoverInstalledVisualWorkspace({ codexHome, explicitServerPath } = {}) {}
```

- [ ] **Step 3: Implement session facade**

```js
export class NativeWorkspaceClient {
  async openApprovedWorkspace({ projectDir, displayMode = "inline" }) {}
  async loadWorkspace() {}
  async readAsset(relPath) {}
  async saveBoard(board) {}
  async selection() {}
  async close() {}
}
```

Read `workspaceId/accessToken/projectRoot` only from private `_meta.widgetData`; never return tokens to browser code.

- [ ] **Step 4: Resolve current thread cwd**

Extend `PreviewRepository` to parse the first `session_meta` line and cache:

```js
metadataById.set(id, { ...previous, cwd: payload.cwd || null });
```

`panel-context.mjs` returns only existing, non-broad, real directories associated with the exact active thread id.

- [ ] **Step 5: Verify and commit**

```bash
node --test assets/runtime/enhancer/test/native-workspace-client.test.mjs assets/runtime/enhancer/test/panel-context.test.mjs
git add assets/runtime/enhancer/lib assets/runtime/enhancer/test assets/runtime/enhancer/lib/preview-data.mjs
git commit -m "feat: bridge panel to native workspace sessions"
```

## Task 4: Create the Trusted Panel Module Registry

**Files:** registry, panel HTML/JS/CSS, tests.

- [ ] **Step 1: Write registry tests**

```js
const registry = new PanelModuleRegistry();
registry.register({ id: "overview", label: "总览", order: 10, mount() {}, destroy() {} });
assert.deepEqual(registry.list().map((entry) => entry.id), ["overview"]);
assert.throws(() => registry.register({ id: "../escape" }), /invalid/i);
```

Test duplicate IDs, missing lifecycle methods, deterministic order, capability filtering, and destroy-all.

- [ ] **Step 2: Implement static registry**

Allow only IDs matching `/^[a-z][a-z0-9-]{1,47}$/`, local module objects, and declared capability strings. Do not support remote URLs or dynamic eval.

- [ ] **Step 3: Build panel shell**

`index.html` contains semantic regions only:

```html
<header id="panelHeader"></header>
<nav id="panelTabs" aria-label="工作台模块"></nav>
<main id="panelContent" tabindex="-1"></main>
<footer id="panelStatus" aria-live="polite"></footer>
```

Register `overview`, `assets`, `canvas`, `tasks`, `changes`, and `tools`. Each module implements `mount`, `onTaskChanged`, and `destroy`.

- [ ] **Step 4: Verify and commit**

```bash
node --test assets/runtime/enhancer/test/panel-module-registry.test.mjs
node --check assets/runtime/enhancer/panel/public/panel.js
git add assets/runtime/enhancer/panel assets/runtime/enhancer/lib/panel-module-registry.mjs assets/runtime/enhancer/test/panel-module-registry.test.mjs
git commit -m "feat: add extensible workspace panel shell"
```

## Task 5: Extend the Private CDP Frame Proxy

**Files:** injector, embed routing, security tests.

- [ ] **Step 1: Write fail-closed route tests**

Cover: wrong origin, wrong nonce, wrong frame id, stale task generation, cross-frame API call, oversized request, unknown method, and token leakage.

- [ ] **Step 2: Define distinct panel routes**

```js
export const WORKSPACE_PANEL_PREFIX = "/__codex_workspace_panel__/";
```

Allow only static files and these API routes:

```text
GET  /api/status
POST /api/workspace/open
GET  /api/workspace
POST /api/asset/read
POST /api/board/save
GET  /api/selection
GET  /api/tasks
GET  /api/changes
```

- [ ] **Step 3: Serve routes in injector**

Use one per-open random nonce and exact OOPIF target. Attach the native session only after `/api/workspace/open` returns `approved`; otherwise return `409 { accessState: "confirmation_required" }`. The new panel must not call `ensureAssetConsoleServer()` and must not start the legacy `5177` service.

- [ ] **Step 4: Verify and commit**

```bash
node --test assets/runtime/enhancer/test/panel-bridge-security.test.mjs
git add assets/runtime/enhancer/lib/asset-console-embed.mjs assets/runtime/enhancer/scripts/injector.mjs assets/runtime/enhancer/test/panel-bridge-security.test.mjs
git commit -m "feat: add private workspace panel bridge"
```

## Task 6: Modernize the Right Rail and Dock

**Files:** injection source, right-rail tests, visual verifier.

- [ ] **Step 1: Expand failing UI assertions**

Expected labels:

```js
assert.deepEqual(labels, ["总览", "资产", "画布", "任务", "变更", "工具"]);
```

Assert 48px rail, 40px targets, 420px minimum dock, keyboard roving tabindex, Escape close, focus restore, no overflow, reduced effects, and full destroy.

- [ ] **Step 2: Replace legacy rail actions**

Keep `WORKSPACE_TOOL_RAIL_ID`, but generate modules from a serialized manifest supplied by injector:

```js
window.__codexConversationPreviewInjection__.setWorkspacePanel({
  available: true,
  modules,
  status,
});
```

The dock remains `role="complementary"`; do not reuse old Asset Console canvas state.

- [ ] **Step 3: Add stable anchor hierarchy**

Prefer current official portal/layout anchors, then `data-app-action-sidebar-scroll`, then fail closed. Record an anchor fingerprint in `data-codex-panel-anchor-tier`.

- [ ] **Step 4: Run visual QA and commit**

```bash
node --test assets/runtime/enhancer/test/native-right-rail.test.mjs
NODE_PATH=plugin/codex-workspace-enhancer/node_modules node assets/runtime/enhancer/scripts/verify-native-right-rail.mjs
git add assets/runtime/enhancer/inject assets/runtime/enhancer/test/native-right-rail.test.mjs assets/runtime/enhancer/scripts/verify-native-right-rail.mjs
git commit -m "feat: modernize the macOS workspace rail"
```

## Task 7: Add Tasks, Worktree, Git, and Native Tool Actions

**Files:** panel context/client and panel JS tests.

- [ ] **Step 1: Test task and Git normalization**

Use fixture session index and repository:

```js
assert.equal(context.threadId, threadId);
assert.equal(context.worktreeRoot, await realpath(repo));
assert.equal(context.git.branch, "feature/panel");
assert.equal(context.git.dirtyCount, 2);
```

- [ ] **Step 2: Implement bounded read-only Git adapter**

Use `execFile("git", [...], { cwd, timeout: 3000, maxBuffer: 1024 * 1024 })`; never invoke a shell. Return branch, ahead/behind, changed paths, and worktree identity only.

- [ ] **Step 3: Implement native actions**

Actions may click verified native controls or populate an unsent composer mention. The API returns:

```js
{ action: "composer-prefilled", sent: false }
```

No action may synthesize Enter or click submit.

- [ ] **Step 4: Verify and commit**

```bash
node --test assets/runtime/enhancer/test/panel-context.test.mjs
git add assets/runtime/enhancer/lib/panel-context.mjs assets/runtime/enhancer/panel/public/panel.js assets/runtime/enhancer/test/panel-context.test.mjs
git commit -m "feat: add workspace task and Git modules"
```

## Task 8: Harden macOS Installation and Lifecycle

**Files:** install config/scripts, launcher, macOS tests/docs.

- [ ] **Step 1: Add installation-plan tests**

Assert panel files are manifest-owned, plugin data is preserved, ordinary ChatGPT/Codex is never killed, and uninstall removes only owned runtime.

- [ ] **Step 2: Add explicit launcher modes**

Support:

```text
--mode enhanced-window
--mode attach-existing --port PORT
--mode stop
```

Default to `enhanced-window`, starting a separate app instance with loopback CDP. `stop` must close injector/bridge and leave ordinary Codex untouched.

- [ ] **Step 3: Fix verifier CLI contract**

Support documented flags:

```text
--installed
--skip-launchctl
--require-stopped
```

`--require-stopped` proves CDP and panel bridge ports are closed.

- [ ] **Step 4: Verify and commit**

```bash
node --test assets/runtime/enhancer/test/install-macos.test.mjs
node assets/runtime/enhancer/scripts/verify-macos.mjs --skip-launchctl --require-stopped
git add assets/runtime/enhancer references/macos-adapter.md
git commit -m "feat: harden macOS workspace panel lifecycle"
```

## Task 9: Full Regression, Security Review, and Release Metadata

**Files:** root docs, manifests, generated artifacts.

- [ ] **Step 1: Run complete quality gates**

```bash
npm run quality
uv run --with pyyaml python ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugin/codex-workspace-enhancer
uv run --with pyyaml python ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugin/codex-workspace-enhancer/skills/visual-workspace
git diff --check
```

Expected: all exit 0; no high-severity production audit findings.

- [ ] **Step 2: Update versions and docs**

Set plugin/root version to `0.3.0`, document optional panel installation, visible port/socket state, PiP fallback, and no-ASAR boundary. Rebuild `dist/server.mjs`, screenshots, reports, and bundle manifests.

- [ ] **Step 3: Independent cold review**

Review authorization, CDP target selection, CSP bypass scope, frame/nonce/session binding, token handling, no-auto-send, install rollback, and source/generated/install parity. Block publication on any P0/P1.

- [ ] **Step 4: Commit release candidate**

```bash
git add CHANGELOG.md README.md README.zh-CN.md references/macos-adapter.md package.json plugin/codex-workspace-enhancer assets/runtime/enhancer assets/runtime/manifest.macos.sha256.json
git commit -m "feat: add macOS Codex workspace panel"
```

## Task 10: Install and Real-Host Acceptance

**Files:** installed runtime and evidence only.

- [ ] **Step 1: Install from the release candidate**

Run dry-run, inspect exact targets, activate the native plugin and optional panel runtime, and verify source/install hashes.

- [ ] **Step 2: Launch an isolated enhanced Codex window**

Prove ordinary window is unchanged and enhanced window shows the 48px rail and dock.

- [ ] **Step 3: Exercise the acceptance matrix**

Verify current project/worktree, approved workspace load, assets, compact board, revision sync with fullscreen, PiP receipt or explicit unsupported outcome, A→B task isolation, Git/Review/Browser/Terminal actions, no auto-send, and complete teardown.

- [ ] **Step 4: Stop runtime and prove cleanup**

Check no listener remains, LaunchAgent state matches policy, injected DOM is gone, and user data remains.

- [ ] **Step 5: Publish only after evidence closes**

Merge the feature branch, push main, wait for GitHub Actions, upgrade the Git marketplace, reinstall the public version, repeat the installed-host smoke, and archive obsolete acceptance tasks.

## Plan Self-Review

- Every design requirement maps to Tasks 1–10.
- The native plugin remains independently usable.
- The panel reuses the native MCP server instead of duplicating workspace state.
- PiP is negotiated and receipt-backed, not assumed.
- CDP and private frame boundaries are tested explicitly.
- Installation, teardown, and real-host visibility are required completion evidence.
- No incomplete placeholders remain.
