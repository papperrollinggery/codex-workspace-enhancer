import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [html, script, styles, injection] = await Promise.all([
  readFile(path.join(root, "panel", "public", "index.html"), "utf8"),
  readFile(path.join(root, "panel", "public", "panel.js"), "utf8"),
  readFile(path.join(root, "panel", "public", "panel.css"), "utf8"),
  readFile(path.join(root, "inject", "conversation-preview.user.js"), "utf8"),
]);

test("panel uses three image-first primary modes instead of six equal dashboard tabs", () => {
  assert.match(script, /const PRIMARY_MODULES = \["overview", "assets", "canvas"\]/u);
  assert.match(script, /id: "overview", label: "工作台"/u);
  assert.match(script, /id: "assets", label: "资产"/u);
  assert.match(script, /id: "canvas", label: "画布"/u);
  assert.doesNotMatch(script, /id: "tasks", label: "任务", order:/u);
  assert.doesNotMatch(styles, /\.status-card/u);
});

test("panel renders real approved image previews and a compact native-board map", () => {
  assert.match(script, /\.\/api\/asset\/read/u);
  assert.match(script, /\.\/api\/board\/save/u);
  assert.match(script, /kind: "asset"/u);
  assert.match(script, /MAX_PREVIEW_CACHE_BYTES/u);
  assert.match(script, /new IntersectionObserver/u);
  assert.match(script, /PREVIEW_CONCURRENCY/u);
  assert.match(script, /const MAX_CANVAS_PREVIEWS = 12/u);
  assert.match(script, /URL\.createObjectURL/u);
  assert.match(script, /URL\.revokeObjectURL/u);
  assert.match(script, /state\.previewActive < PREVIEW_CONCURRENCY/u);
  assert.match(script, /resetPreviewScheduling\(\)/u);
  assert.match(script, /className = "asset-contact-sheet"/u);
  assert.match(script, /className = "compact-canvas"/u);
  assert.match(script, /item\.kind === "asset"/u);
  assert.match(script, /item\.kind === "note"/u);
});

test("workbench integrates task, changes, and tools without duplicating Codex navigation", () => {
  assert.match(script, /Promise\.all\(\[api\("\.\/api\/status"\), api\("\.\/api\/workspace"\), api\("\.\/api\/tasks"\), api\("\.\/api\/changes"\), api\("\.\/api\/tools"\)\]\)/u);
  assert.match(styles, /\.workbench-layout/u);
  assert.match(styles, /\.change-list/u);
  assert.match(script, /setInterval\(\(\) => \{[\s\S]{0,260}api\("\.\/api\/changes"\)/u);
  assert.match(script, /clearInterval\(overviewRefreshTimer\)/u);
  assert.match(styles, /\.tool-row/u);
  assert.match(html, /class="panel-brand-mark"/u);
});

test("dock follows the documented 560px creative sidecar default", () => {
  assert.match(injection, /const WORKSPACE_DOCK_DEFAULT_WIDTH = 560/u);
  assert.doesNotMatch(injection, /inset 3px 0 0 #2f95ff/u);
  assert.match(injection, /codex-asset-console-resizer[\s\S]{0,260}width: 40px/u);
  assert.match(injection, /codex-asset-console-retry[\s\S]{0,180}min-height: 40px/u);
});

test("panel binds its scroll surface and footer to the iframe viewport", () => {
  assert.match(styles, /html, body \{[^}]*height: 100%;[^}]*min-height: 0;[^}]*overflow: hidden;/u);
  assert.match(styles, /\.panel-app \{[^}]*height: 100%;[^}]*min-height: 0;/u);
  assert.match(script, /填写打开画布请求/u);
});
