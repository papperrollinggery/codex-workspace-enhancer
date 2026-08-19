import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const injection = await readFile(path.join(root, "inject", "conversation-preview.user.js"), "utf8");
const injector = await readFile(path.join(root, "scripts", "injector.mjs"), "utf8");
const assetConsoleApp = await readFile(path.join(root, "asset-console", "public", "app.js"), "utf8");
const workspacePanelApp = await readFile(path.join(root, "panel", "public", "panel.js"), "utf8");

test("native injection owns and cleans up a right-side tool rail", () => {
  assert.match(injection, /const WORKSPACE_TOOL_RAIL_ID = "codex-workspace-tool-rail"/u);
  assert.match(injection, /label: "资产库"/u);
  assert.match(injection, /label: "空间画布"/u);
  assert.match(injection, /label: "插件与 Skill"/u);
  assert.match(injection, /document\.getElementById\(WORKSPACE_TOOL_RAIL_ID\)\?\.remove\(\)/u);
});

test("native injection lifecycle cannot revive a destroyed loading instance", () => {
  assert.match(injection, /window\[SENTINEL\]\?\.runtimeToken !== RUNTIME_TOKEN/u);
  assert.match(injection, /document\.removeEventListener\("DOMContentLoaded", domReadyListener\)/u);
  assert.match(injection, /function nativeWorkspaceAnchors\(\)/u);
  assert.match(injection, /if \(!anchors\)/u);
});

test("asset dock is resizable, keyboard accessible, and not presented as a modal", () => {
  assert.match(injection, /role="separator"[^>]+tabindex="0"/u);
  assert.match(injection, /panel\.setAttribute\("role", "complementary"\)/u);
  assert.match(injection, /event\.key === "ArrowLeft" \? 24 : -24/u);
  assert.match(injection, /WORKSPACE_DOCK_WIDTH_KEY/u);
});

test("canvas selection crosses only the private embedded parent channel", () => {
  assert.match(injection, /action: "open-view"/u);
  assert.match(injection, /message\.action === "view-changed"/u);
  assert.match(injection, /"https:\/\/web-sandbox\.oaiusercontent\.com"/u);
  assert.match(assetConsoleApp, /event\.source !== window\.parent/u);
  assert.match(assetConsoleApp, /event\.data\.action === "open-view"/u);
  assert.match(assetConsoleApp, /event\.data\.view === "canvas" \? "canvas" : "grid"/u);
  assert.match(assetConsoleApp, /action: "view-changed"/u);
});

test("injector owns a native workspace panel bridge without starting legacy AssetBrowser", () => {
  assert.match(injector, /const WORKSPACE_PANEL_BINDING = "codexWorkspacePanel"/u);
  assert.match(injector, /new NativeWorkspaceClient/u);
  assert.match(injector, /resolvePanelContext/u);
  assert.match(injector, /workspacePanelEmbedUrl/u);
  assert.match(injector, /path\.join\(root, "panel", "public"\)/u);
  assert.match(injector, /name: "panel\.js"/u);
  const handler = injector.slice(
    injector.indexOf("async function handleWorkspacePanelBinding"),
    injector.indexOf("async function bindWorkspaceIntegrations"),
  );
  assert.match(handler, /message\.panel !== "workspace"/u);
  assert.doesNotMatch(handler, /ensureAssetConsoleServer\(\)/u);
});

test("right rail exposes the native workspace panel as a first-class macOS surface", () => {
  assert.match(injection, /label: "工作面板"/u);
  assert.match(injection, /typeof window\.codexWorkspacePanel !== "function"/u);
  assert.match(injection, /panel: "workspace"/u);
  assert.match(injection, /function setWorkspacePanel\(/u);
  assert.match(injection, /function setWorkspacePanelFrame\(/u);
  assert.match(injection, /\.ProseMirror\[role="textbox"\]\[aria-multiline="true"\]/u);
  assert.match(injection, /setWorkspacePanel,/u);
  assert.match(injection, /setWorkspacePanelFrame,/u);
  assert.match(workspacePanelApp, /source: "workspace-panel", action: "close"/u);
  assert.match(injection, /message\?\.source === "workspace-panel" && message\.action === "close"/u);
  const openPanel = injection.slice(injection.indexOf("function openAssetConsolePanel"), injection.indexOf("function openWorkspacePanel"));
  assert.doesNotMatch(openPanel, /innerHTML\s*=\s*`[^`]*\$\{panelLabel\}/su);
  assert.match(openPanel, /querySelector\("\[data-codex-panel-title\]"\)\.textContent = panelLabel/u);
});
