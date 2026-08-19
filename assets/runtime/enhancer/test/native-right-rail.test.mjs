import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const injection = await readFile(path.join(root, "inject", "conversation-preview.user.js"), "utf8");
const assetConsoleApp = await readFile(path.join(root, "asset-console", "public", "app.js"), "utf8");

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
