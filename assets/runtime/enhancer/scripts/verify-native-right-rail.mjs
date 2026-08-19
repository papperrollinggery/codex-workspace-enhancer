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
const injection = await readFile(path.join(root, "inject", "conversation-preview.user.js"), "utf8");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
const cdp = await page.context().newCDPSession(page);
const consoleErrors = [];
const pageErrors = [];
let lifecycleMetrics = null;
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
  await page.route("https://web-sandbox.oaiusercontent.com/**", (route) => route.fulfill({
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
  }));
  await page.goto("https://codex.local/");
  await page.evaluate(() => {
    window.__assetActions = [];
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
  });
  await page.evaluate(injection);
  await page.evaluate(() => {
    window.__codexConversationPreviewInjection__.setAssetConsole({
      available: true,
      label: "资产控制台",
      mode: "embedded",
    });
  });
  await page.waitForSelector("#codex-workspace-tool-rail [data-codex-workspace-tool='canvas']");

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
  assert.deepEqual(initial.labels, ["资产库", "空间画布", "插件与 Skill"]);
  assert.equal(initial.rail.width, 48);
  assert.ok(initial.buttonRects.every((rect) => rect.width >= 40 && rect.height >= 40));
  assert.equal(initial.overflow, 0);
  assert.deepEqual(await page.locator("#codex-workspace-tool-rail button").evaluateAll((buttons) => buttons.map((button) => button.tabIndex)), [0, -1, -1]);
  assert.equal(await page.getAttribute("[data-codex-workspace-tool='skills']", "aria-pressed"), null);

  await page.locator("[data-codex-workspace-tool='grid']").focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.codexWorkspaceTool), "canvas");
  assert.deepEqual(await page.locator("#codex-workspace-tool-rail button").evaluateAll((buttons) => buttons.map((button) => button.tabIndex)), [-1, 0, -1]);

  await page.click("[data-codex-workspace-tool='canvas']");
  const assetFrame = page.frameLocator("#codex-asset-console-frame");
  await assetFrame.locator("body[data-view='canvas']").waitFor();
  const readyLayout = await page.evaluate(() => {
    const state = document.querySelector(".codex-asset-console-state");
    const body = document.querySelector(".codex-asset-console-body").getBoundingClientRect();
    const frame = document.querySelector("#codex-asset-console-frame").getBoundingClientRect();
    return {
      stateHidden: state.hidden,
      stateDisplay: getComputedStyle(state).display,
      frameMatchesBody: Math.abs(frame.width - body.width) <= 1 && Math.abs(frame.height - body.height) <= 1,
    };
  });
  assert.deepEqual(readyLayout, { stateHidden: true, stateDisplay: "none", frameMatchesBody: true });
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
  assert.ok(opened.width >= 600);
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
    screenshots: ["/tmp/codex-native-right-rail-dark.png", "/tmp/codex-native-right-rail-light.png"],
    reduced,
    lifecycle: lifecycleMetrics,
    consoleErrors: consoleErrors.length,
    pageErrors: pageErrors.length,
  }, null, 2)}\n`);
} finally {
  await browser.close();
}
