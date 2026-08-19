import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (error) {
  throw new Error("Playwright is required. Set NODE_PATH to the Codex bundled node_modules directory.", { cause: error });
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(root, "../../..");
const injection = await readFile(path.join(root, "inject", "conversation-preview.user.js"), "utf8");
const panelRoot = path.join(root, "panel", "public");
const LONG_PROJECT_NAME = "跨项目视觉工作区与品牌片参考资产整合验收";
const LONG_THREAD_TITLE = "验证超长中文任务标题、复杂 worktree 路径和多模块上下文在窄面板中的重排";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
const cdp = await page.context().newCDPSession(page);
const consoleErrors = [];
const pageErrors = [];
let lifecycleMetrics = null;
let boardSaves = 0;
let panelMetrics = null;
let panelReduced = null;
let panelContrast = null;
const responsiveMatrix = [];
let previewActive = 0;
let previewMaxActive = 0;
let previewRequests = 0;
let changeReads = 0;
let savedBoard = null;
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  const mockHost = `<!doctype html>
    <html><head><style>
      :root { --color-token-main-surface-primary: #f6f7f9; --color-token-text-primary: #15171a; --color-token-description-foreground: #626975; --color-token-accent-foreground: #006bd6; }
      @media (prefers-color-scheme: dark) { :root { --color-token-main-surface-primary: #171717; --color-token-text-primary: #f5f5f5; --color-token-description-foreground: #a7a7a7; --color-token-accent-foreground: #4aa4ff; } }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; color: var(--color-token-text-primary); background: #111; font-family: system-ui; }
      body { display: grid; grid-template-columns: 280px 1fr; }
      aside { position: relative; background: #181818; border-right: 1px solid #2b2b2b; }
      aside nav { padding: 52px 12px 12px; }
      main { min-width: 0; padding: 72px 64px; background: radial-gradient(circle at 70% 20%, #202633, #111 55%); }
      main h1 { font-size: 32px; }
      button { color: inherit; }
      .native-plugin { width: 120px; height: 40px; }
    </style></head><body>
      <aside><nav><button class="native-plugin" type="button" title="插件">插件</button><div data-app-action-sidebar-scroll></div></nav></aside>
      <main><h1>Codex 工作区</h1><p>Mock host for native injection verification.</p><div contenteditable="true">输入框</div></main>
    </body></html>`;
  await page.route("https://codex.local/", (route) => route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: mockHost,
  }));
  await page.route("https://web-sandbox.oaiusercontent.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/workspace-panel-test/")) {
      const relative = url.pathname.slice("/workspace-panel-test/".length);
      const staticFiles = {
        "": ["index.html", "text/html; charset=utf-8"],
        "index.html": ["index.html", "text/html; charset=utf-8"],
        "panel.js": ["panel.js", "text/javascript; charset=utf-8"],
        "panel.css": ["panel.css", "text/css; charset=utf-8"],
        "module-registry.mjs": ["module-registry.mjs", "text/javascript; charset=utf-8"],
      };
      if (staticFiles[relative]) {
        const [name, contentType] = staticFiles[relative];
        return route.fulfill({ status: 200, contentType, body: await readFile(path.join(panelRoot, name), "utf8") });
      }
      const apiPayloads = {
        "api/status": { version: "0.3.0", bridgeState: "ready", threadId: "mock-thread", threadTitle: LONG_THREAD_TITLE, projectDir: "/Users/qa/Creative Projects/2026/Codex Workspace Enhancer/超长项目路径/当前工作树", projectName: LONG_PROJECT_NAME, accessState: "approved", authorizationSource: "host-root" },
        "api/workspace": { assets: Array.from({ length: 12 }, (_, index) => ({
          name: `frame-${String(index + 1).padStart(2, "0")}.png`,
          folder: index < 8 ? "references" : "outputs",
          relPath: index === 0 ? "references/frame-01.png" : index === 1 ? "references/frame-02.png" : index === 2 ? "outputs/board.png" : `references/frame-${String(index + 1).padStart(2, "0")}.png`,
        })), board: savedBoard || { rev: 3, nodes: [
          { id: "node-1", kind: "asset", relPath: "references/frame-01.png", label: "Frame 01", x: 0, y: 0, width: 320, height: 220 },
          { id: "node-2", kind: "note", text: "保持人物方向一致", tone: "amber", x: 360, y: 80, width: 220, height: 160 },
        ], selectedIds: ["node-1"] }, truncated: false },
        "api/tasks": { tasks: [{ threadId: "mock-thread", title: LONG_THREAD_TITLE, status: "current" }] },
        "api/changes": { branch: "feat/panel", dirtyCount: 2, ahead: 1, behind: 0, paths: ["panel.js", "panel.css"] },
        "api/tools": { tools: [
          { id: "visual-workspace", label: "Visual Workspace", available: true, action: "native-mcp-app" },
          { id: "review", label: "Review", available: true, action: "native-route" },
        ] },
      };
      if (relative === "api/asset/read") {
        previewRequests += 1;
        previewActive += 1;
        previewMaxActive = Math.max(previewMaxActive, previewActive);
        await new Promise((resolve) => setTimeout(resolve, 24));
        const input = JSON.parse(route.request().postData() || "{}");
        const sources = {
          "references/frame-01.png": "assets/ui-review/native-visual-workspace-dark.png",
          "references/frame-02.png": "assets/ui-review/native-visual-workspace-light.png",
          "outputs/board.png": "assets/ui-review/asset-console-canvas-dark.png",
        };
        const source = sources[input.relPath] || sources["references/frame-01.png"];
        const dataBase64 = (await readFile(path.join(repositoryRoot, source))).toString("base64");
        previewActive -= 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mimeType: "image/png", dataBase64 }) });
      }
      if (relative === "api/board/save") {
        boardSaves += 1;
        const input = JSON.parse(route.request().postData() || "{}");
        if (boardSaves === 2) {
          savedBoard = { ...input, rev: 9 };
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conflict: true, currentBoard: savedBoard }) });
        }
        savedBoard = { ...input, rev: input.baseRev + 1 };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ board: savedBoard }) });
      }
      if (relative === "api/tools/action") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ action: "composer-prefilled", sent: false }) });
      if (relative === "api/changes") changeReads += 1;
      if (apiPayloads[relative]) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(apiPayloads[relative]) });
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
    }
    return route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><body data-view="grid"><button id="show-grid">Grid</button><button id="show-canvas">Canvas</button><script>
      const setView = (view) => {
        document.body.dataset.view = view;
        window.parent.postMessage({ source: "asset-console", action: "view-changed", view }, "*");
      };
      window.addEventListener("message", (event) => {
        if (event.data?.source === "codex-sidebar-enhancer" && event.data?.action === "open-view") setView(event.data.view === "canvas" ? "canvas" : "grid");
      });
      document.querySelector("#show-grid").onclick = () => setView("grid");
      document.querySelector("#show-canvas").onclick = () => setView("canvas");
    <\/script></body></html>`,
    });
  });
  await page.goto("https://codex.local/");
  await page.evaluate(() => {
    window.__assetActions = [];
    window.__workspaceActions = [];
    window.__pluginClicks = 0;
    document.querySelector(".native-plugin").addEventListener("click", () => { window.__pluginClicks += 1; });
    window.codexSidebarOpenAssetConsole = (payload) => {
      const action = JSON.parse(payload);
      window.__assetActions.push(action);
      if (action.action === "open") {
        setTimeout(() => window.__codexConversationPreviewInjection__.setAssetConsolePanel({
          state: "ready",
          url: "https://web-sandbox.oaiusercontent.com/codex-asset-console-test",
        }), 0);
      }
    };
    window.codexWorkspacePanel = (payload) => {
      const action = JSON.parse(payload);
      window.__workspaceActions.push(action);
      if (action.action === "open") {
        setTimeout(() => window.__codexConversationPreviewInjection__.setWorkspacePanelFrame({
          state: "ready",
          url: "https://web-sandbox.oaiusercontent.com/workspace-panel-test/",
          accessState: "approved",
        }), 0);
      }
    };
  });
  await page.evaluate(injection);
  await page.evaluate(() => {
    window.__codexConversationPreviewInjection__.setAssetConsole({
      available: true,
      label: "资产控制台",
      mode: "embedded",
    });
    window.__codexConversationPreviewInjection__.setWorkspacePanel({
      available: true,
      label: "工作面板",
      mode: "native-mcp",
    });
  });
  await page.waitForSelector("#codex-workspace-tool-rail [data-codex-workspace-tool='workspace']");

  const initial = await page.evaluate(() => {
    const rail = document.querySelector("#codex-workspace-tool-rail");
    const buttons = Array.from(rail.querySelectorAll("button"));
    return {
      labels: buttons.map((button) => button.getAttribute("aria-label")),
      rail: rail.getBoundingClientRect().toJSON(),
      buttonRects: buttons.map((button) => button.getBoundingClientRect().toJSON()),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  assert.deepEqual(initial.labels, ["工作面板", "资产库", "空间画布", "插件与 Skill"]);
  assert.equal(initial.rail.width, 48);
  assert.ok(initial.buttonRects.every((rect) => rect.width >= 40 && rect.height >= 40));
  assert.equal(initial.overflow, 0);
  assert.deepEqual(await page.locator("#codex-workspace-tool-rail button").evaluateAll((buttons) => buttons.map((button) => button.tabIndex)), [0, -1, -1, -1]);
  assert.equal(await page.getAttribute("[data-codex-workspace-tool='skills']", "aria-pressed"), null);

  await page.click("[data-codex-workspace-tool='workspace']");
  await page.waitForSelector("#codex-asset-console-panel[data-panel-kind='workspace'] iframe");
  const workspaceFrame = page.frameLocator("#codex-asset-console-frame");
  await workspaceFrame.locator("#panelTitle").filter({ hasText: LONG_PROJECT_NAME }).waitFor();
  assert.deepEqual(
    await workspaceFrame.locator("#panelTabs button").allTextContents(),
    ["工作台", "资产", "画布"],
  );
  await workspaceFrame.locator(".asset-tile img[src^='blob:']").first().waitFor();
  await workspaceFrame.locator(".compact-canvas .canvas-node[data-kind='asset']").waitFor();
  await workspaceFrame.getByText("feat/panel").waitFor();
  panelMetrics = await workspaceFrame.locator("body").evaluate((body) => {
    const targets = [...body.querySelectorAll("button")].filter((button) => button.getBoundingClientRect().width > 0);
    return {
      minimumTargetHeight: Math.min(...targets.map((button) => button.getBoundingClientRect().height)),
      overflowX: body.scrollWidth - body.clientWidth,
      primaryModes: [...body.querySelectorAll("#panelTabs button")].map((button) => button.textContent.trim()),
    };
  });
  assert.ok(panelMetrics.minimumTargetHeight >= 40, JSON.stringify(panelMetrics));
  assert.equal(panelMetrics.overflowX, 0);
  for (const width of [420, 560, 720]) {
    await page.evaluate((nextWidth) => {
      document.querySelector("#codex-asset-console-panel")?.style.setProperty("--codex-workspace-dock-width", `${nextWidth}px`);
    }, width);
    await page.waitForTimeout(80);
    const parentWidth = await page.locator("#codex-asset-console-panel").evaluate((panel) => panel.getBoundingClientRect().width);
    const metrics = await workspaceFrame.locator("body").evaluate((body) => {
      const buttons = [...body.querySelectorAll("button")].filter((button) => button.getBoundingClientRect().width > 0);
      const footer = body.querySelector(".panel-footer").getBoundingClientRect();
      const content = body.querySelector(".panel-content");
      content.scrollTop = content.scrollHeight;
      const maxScrollTop = content.scrollTop;
      content.scrollTop = 0;
      const firstMode = body.querySelector("#panelTabs button");
      firstMode.focus();
      return {
        overflowX: body.scrollWidth - body.clientWidth,
        minimumTargetWidth: Math.min(...buttons.map((button) => button.getBoundingClientRect().width)),
        minimumTargetHeight: Math.min(...buttons.map((button) => button.getBoundingClientRect().height)),
        footerVisible: footer.top >= 0 && footer.bottom <= window.innerHeight + 0.5,
        contentScrollable: content.scrollHeight > content.clientHeight && maxScrollTop > 0,
        focusOutline: getComputedStyle(firstMode).outlineWidth,
      };
    });
    responsiveMatrix.push({ width, parentWidth, ...metrics });
    assert.ok(Math.abs(parentWidth - width) <= 1, JSON.stringify(responsiveMatrix.at(-1)));
    assert.equal(metrics.overflowX, 0, JSON.stringify(responsiveMatrix.at(-1)));
    assert.ok(metrics.minimumTargetWidth >= 40 && metrics.minimumTargetHeight >= 40, JSON.stringify(responsiveMatrix.at(-1)));
    assert.equal(metrics.footerVisible, true, JSON.stringify(responsiveMatrix.at(-1)));
    assert.equal(metrics.contentScrollable, true, JSON.stringify(responsiveMatrix.at(-1)));
    assert.equal(metrics.focusOutline, "3px", JSON.stringify(responsiveMatrix.at(-1)));
    await page.screenshot({ path: `/tmp/codex-workspace-panel-${width}.png` });
  }
  await page.evaluate(() => document.querySelector("#codex-asset-console-panel")?.style.setProperty("--codex-workspace-dock-width", "560px"));
  await page.waitForTimeout(5_200);
  assert.ok(changeReads >= 2, `dynamic Git reads ${changeReads}`);
  await page.screenshot({ path: "/tmp/codex-workspace-panel-overview-dark.png" });
  await workspaceFrame.getByRole("button", { name: "加入画布" }).first().click();
  await workspaceFrame.getByText("已加入画布").waitFor();
  await workspaceFrame.getByText("Revision 4").waitFor();
  assert.equal(boardSaves, 1);
  await workspaceFrame.getByRole("button", { name: "加入画布" }).first().click();
  await workspaceFrame.getByText("画布已在另一个视图更新").waitFor();
  await workspaceFrame.getByText("Revision 9").waitFor();
  assert.equal(boardSaves, 2);
  await workspaceFrame.getByRole("button", { name: /准备打开画布/u }).click();
  await workspaceFrame.getByText("尚未发送").waitFor();
  await workspaceFrame.getByRole("button", { name: "资产", exact: true }).click();
  await workspaceFrame.locator(".asset-contact-sheet .asset-tile").first().waitFor();
  await workspaceFrame.locator(".asset-tile img[src^='blob:']").nth(5).waitFor();
  assert.ok(previewRequests >= 6);
  assert.ok(previewMaxActive <= 3, `preview concurrency ${previewMaxActive}`);
  await page.screenshot({ path: "/tmp/codex-workspace-panel-assets-dark.png" });
  await workspaceFrame.getByRole("button", { name: "画布", exact: true }).click();
  await workspaceFrame.locator(".compact-canvas[data-tall='true']").waitFor();
  panelContrast = await workspaceFrame.locator(".action-button.primary").evaluate((button) => {
    const parse = (value) => value.match(/[\d.]+/gu).slice(0, 3).map((part) => Number(part) / 255);
    const luminance = (value) => {
      const channels = parse(value).map((part) => part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4);
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const styles = getComputedStyle(button);
    const values = [luminance(styles.color), luminance(styles.backgroundColor)].sort((left, right) => right - left);
    return (values[0] + 0.05) / (values[1] + 0.05);
  });
  assert.ok(panelContrast >= 4.5, `primary contrast ${panelContrast}`);
  assert.equal(await page.getAttribute("[data-codex-workspace-tool='workspace']", "aria-pressed"), "true");
  assert.equal(await page.evaluate(() => window.__workspaceActions.at(-1)?.panel), "workspace");
  await page.screenshot({ path: "/tmp/codex-workspace-panel-dark.png" });
  await workspaceFrame.locator("body").press("Escape");
  await page.waitForSelector("#codex-asset-console-panel", { state: "detached" });

  await page.locator("[data-codex-workspace-tool='grid']").focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.codexWorkspaceTool), "canvas");
  assert.deepEqual(await page.locator("#codex-workspace-tool-rail button").evaluateAll((buttons) => buttons.map((button) => button.tabIndex)), [-1, -1, 0, -1]);

  await page.click("[data-codex-workspace-tool='canvas']");
  const assetFrame = page.frameLocator("#codex-asset-console-frame");
  await assetFrame.locator("body[data-view='canvas']").waitFor();
  const readyLayout = await page.evaluate(() => {
    const state = document.querySelector(".codex-asset-console-state");
    const body = document.querySelector(".codex-asset-console-body").getBoundingClientRect();
    const frame = document.querySelector("#codex-asset-console-frame").getBoundingClientRect();
    const resizer = document.querySelector(".codex-asset-console-resizer").getBoundingClientRect();
    return {
      stateHidden: state.hidden,
      stateDisplay: getComputedStyle(state).display,
      frameMatchesBody: Math.abs(frame.width - body.width) <= 1 && Math.abs(frame.height - body.height) <= 1,
      resizerWidth: resizer.width,
    };
  });
  assert.deepEqual(readyLayout, { stateHidden: true, stateDisplay: "none", frameMatchesBody: true, resizerWidth: 40 });
  const opened = await page.evaluate(() => {
    const panel = document.querySelector("#codex-asset-console-panel");
    const canvas = document.querySelector("[data-codex-workspace-tool='canvas']");
    return {
      role: panel?.getAttribute("role"),
      view: panel?.dataset.view,
      width: panel?.getBoundingClientRect().width,
      canvasPressed: canvas?.getAttribute("aria-pressed"),
      actions: window.__assetActions,
    };
  });
  assert.equal(opened.role, "complementary");
  assert.equal(opened.view, "canvas");
  assert.equal(opened.canvasPressed, "true");
  assert.ok(opened.width >= 540);
  assert.equal(opened.actions.at(-1)?.action, "open");

  await page.evaluate(() => {
    const frame = document.querySelector("#codex-asset-console-frame");
    window.dispatchEvent(new MessageEvent("message", {
      origin: "https://evil.example",
      source: frame.contentWindow,
      data: { source: "asset-console", action: "view-changed", view: "grid" },
    }));
  });
  assert.equal(await page.getAttribute("[data-codex-workspace-tool='canvas']", "aria-pressed"), "true");
  await assetFrame.locator("#show-grid").click();
  await page.waitForFunction(() => document.querySelector("[data-codex-workspace-tool='grid']")?.getAttribute("aria-pressed") === "true");
  await assetFrame.locator("#show-canvas").click();
  await page.waitForFunction(() => document.querySelector("[data-codex-workspace-tool='canvas']")?.getAttribute("aria-pressed") === "true");

  const resizer = page.locator(".codex-asset-console-resizer");
  await resizer.focus();
  await page.keyboard.press("ArrowLeft");
  const resized = await page.evaluate(() => ({
    width: document.querySelector("#codex-asset-console-panel")?.getBoundingClientRect().width,
    saved: Number(localStorage.getItem("codex-workspace-enhancer:right-dock-width-v1")),
    outline: getComputedStyle(document.querySelector(".codex-asset-console-resizer")).outlineWidth,
  }));
  assert.ok(resized.width > opened.width);
  assert.equal(resized.saved, resized.width);
  assert.equal(resized.outline, "3px");
  await page.screenshot({ path: "/tmp/codex-native-right-rail-dark.png" });

  await cdp.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: "light" },
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-reduced-transparency", value: "reduce" },
    ],
  });
  const reduced = await page.evaluate(() => {
    const rail = getComputedStyle(document.querySelector("#codex-workspace-tool-rail"));
    const button = getComputedStyle(document.querySelector("[data-codex-workspace-tool='canvas']"));
    return {
      backdrop: rail.backdropFilter || rail.webkitBackdropFilter,
      background: rail.backgroundColor,
      transitionDuration: button.transitionDuration,
    };
  });
  assert.equal(reduced.backdrop, "none");
  assert.notEqual(reduced.background, "rgba(0, 0, 0, 0)");
  assert.ok(reduced.transitionDuration.split(",").every((value) => Number.parseFloat(value) <= 0.00001));
  await page.screenshot({ path: "/tmp/codex-native-right-rail-light.png" });

  await page.keyboard.press("Escape");
  await page.waitForSelector("#codex-asset-console-panel", { state: "detached" });
  assert.equal(await page.getAttribute("[data-codex-workspace-tool='canvas']", "aria-pressed"), "false");

  await page.click("[data-codex-workspace-tool='workspace']");
  await workspaceFrame.locator(".workbench-view").waitFor();
  panelReduced = await workspaceFrame.locator("body").evaluate((body) => ({
    background: getComputedStyle(body).backgroundColor,
    transitionDuration: getComputedStyle(body.querySelector("#panelTabs button")).transitionDuration,
  }));
  assert.notEqual(panelReduced.background, "rgba(0, 0, 0, 0)");
  assert.ok(panelReduced.transitionDuration.split(",").every((value) => Number.parseFloat(value) <= 0.00001));
  await page.screenshot({ path: "/tmp/codex-workspace-panel-light.png" });
  await workspaceFrame.locator("body").press("Escape");
  await page.waitForSelector("#codex-asset-console-panel", { state: "detached" });

  await page.click("[data-codex-workspace-tool='grid']");
  assert.equal(await page.getAttribute("#codex-asset-console-panel", "data-view"), "grid");
  await page.click("[data-codex-workspace-tool='skills']");
  await page.waitForFunction(() => window.__pluginClicks === 1);
  assert.equal(await page.locator("#codex-asset-console-panel").count(), 0);

  await page.evaluate(() => window.__codexConversationPreviewInjection__.destroy());
  assert.equal(await page.locator("#codex-workspace-tool-rail").count(), 0);
  assert.equal(await page.locator("#codex-conversation-preview-style").count(), 0);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);

  const lifecyclePage = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  try {
    await lifecyclePage.addInitScript({ content: `
      window.__observerStats = { created: 0, active: 0, tokens: [] };
      const NativeMutationObserver = window.MutationObserver;
      window.MutationObserver = class TrackedMutationObserver extends NativeMutationObserver {
        constructor(callback) { super(callback); window.__observerStats.created += 1; window.__observerStats.tokens.push(window.__codexConversationPreviewInjection__?.runtimeToken || "missing"); this.__trackedActive = false; }
        observe(...args) { if (!this.__trackedActive) { this.__trackedActive = true; window.__observerStats.active += 1; } return super.observe(...args); }
        disconnect() { if (this.__trackedActive) { this.__trackedActive = false; window.__observerStats.active -= 1; } return super.disconnect(); }
      };
      ${injection}
      ${injection}
    ` });
    await lifecyclePage.route("https://codex-lifecycle.local/", (route) => route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><body><aside><div data-app-action-sidebar-scroll></div></aside><main style="width:800px;height:600px"></main></body></html>`,
    }));
    await lifecyclePage.goto("https://codex-lifecycle.local/");
    await lifecyclePage.evaluate(() => window.__codexConversationPreviewInjection__.setAssetConsole({ available: true }));
    await lifecyclePage.waitForTimeout(120);
    const beforeDestroy = await lifecyclePage.evaluate(() => ({
      ...window.__observerStats,
      railCount: document.querySelectorAll("#codex-workspace-tool-rail").length,
    }));
    assert.equal(beforeDestroy.created, 1, JSON.stringify(beforeDestroy));
    assert.equal(beforeDestroy.active, 1, JSON.stringify(beforeDestroy));
    assert.equal(beforeDestroy.railCount, 1, JSON.stringify(beforeDestroy));
    await lifecyclePage.evaluate(() => window.__codexConversationPreviewInjection__.destroy());
    const afterDestroy = await lifecyclePage.evaluate(() => ({
      ...window.__observerStats,
      railCount: document.querySelectorAll("#codex-workspace-tool-rail").length,
    }));
    assert.equal(afterDestroy.created, 1, JSON.stringify(afterDestroy));
    assert.equal(afterDestroy.active, 0, JSON.stringify(afterDestroy));
    assert.equal(afterDestroy.railCount, 0, JSON.stringify(afterDestroy));
    lifecycleMetrics = { beforeDestroy, afterDestroy };
  } finally {
    await lifecyclePage.close();
  }

  const negativePage = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  try {
    await negativePage.route("https://codex-login.local/", (route) => route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><body><main style="width:900px;height:600px"><button id="false-plugin" title="插件">插件</button></main></body></html>`,
    }));
    await negativePage.goto("https://codex-login.local/");
    await negativePage.evaluate(injection);
    await negativePage.evaluate(() => window.__codexConversationPreviewInjection__.setAssetConsole({ available: true }));
    await negativePage.waitForTimeout(160);
    assert.equal(await negativePage.locator("#codex-workspace-tool-rail").count(), 0);
    assert.equal(await negativePage.locator("#codex-asset-console-panel").count(), 0);
    await negativePage.evaluate(() => window.__codexConversationPreviewInjection__.destroy());
  } finally {
    await negativePage.close();
  }

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    tools: initial.labels,
    panelWidth: resized.width,
    minimumTarget: 40,
    screenshots: ["/tmp/codex-workspace-panel-420.png", "/tmp/codex-workspace-panel-560.png", "/tmp/codex-workspace-panel-720.png", "/tmp/codex-workspace-panel-overview-dark.png", "/tmp/codex-workspace-panel-assets-dark.png", "/tmp/codex-workspace-panel-dark.png", "/tmp/codex-workspace-panel-light.png", "/tmp/codex-native-right-rail-dark.png", "/tmp/codex-native-right-rail-light.png"],
    reduced,
    lifecycle: lifecycleMetrics,
    consoleErrors: consoleErrors.length,
    pageErrors: pageErrors.length,
    boardSaves,
    panelMetrics,
    panelReduced,
    panelContrast,
    responsiveMatrix,
    previewRequests,
    previewMaxActive,
    changeReads,
  }, null, 2)}\n`);
} finally {
  await browser.close();
}
