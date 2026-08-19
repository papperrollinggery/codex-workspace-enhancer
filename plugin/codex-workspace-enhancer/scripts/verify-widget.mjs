import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { inlineWidget } from "../mcp/lib/widget-resource.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const accessToken = "a".repeat(43);
const outputDir = path.resolve(process.env.VISUAL_WORKSPACE_QA_OUTPUT || path.join(ROOT, "artifacts"));
await mkdir(outputDir, { recursive: true });
const sources = ["references/story-frames.png", "references/color-world.png", "references/campaign-map.png"];
const fixtureSvg = (title, accent, offset) => `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#101522"/><stop offset="1" stop-color="#29334a"/></linearGradient><linearGradient id="a"><stop stop-color="${accent}"/><stop offset="1" stop-color="#ffcf70"/></linearGradient></defs><rect width="1280" height="800" fill="url(#bg)"/><circle cx="${280 + offset}" cy="310" r="170" fill="url(#a)" opacity=".94"/><rect x="520" y="155" width="530" height="350" rx="38" fill="#f7f4ef"/><path d="M570 420 720 255l110 110 92-78 90 133z" fill="${accent}" opacity=".82"/><text x="70" y="690" fill="white" font-family="-apple-system, sans-serif" font-size="64" font-weight="700">${title}</text><text x="73" y="742" fill="#aebbd3" font-family="-apple-system, sans-serif" font-size="24">VISUAL DIRECTION · CREATIVE REFERENCE</text></svg>`;
const imagePayloads = Object.fromEntries([
  [sources[0], Buffer.from(fixtureSvg("STORY FRAMES", "#6c83ff", 0)).toString("base64")],
  [sources[1], Buffer.from(fixtureSvg("COLOR WORLD", "#ff6e8a", 170)).toString("base64")],
  [sources[2], Buffer.from(fixtureSvg("CAMPAIGN MAP", "#4fd0b6", 340)).toString("base64")],
]);
const css = await readFile(path.join(ROOT, "widget", "styles.css"), "utf8");
const js = await readFile(path.join(ROOT, "widget", "app.js"), "utf8");
const baseHtml = await readFile(path.join(ROOT, "widget", "index.html"), "utf8");
let html = baseHtml.replace("/* __VISUAL_WORKSPACE_CSS__ */", css).replace("/* __VISUAL_WORKSPACE_JS__ */", js);

const assets = [
  { id: "light", relPath: sources[0], name: "Story frames.png", folder: "references", size: 420000, modifiedAt: new Date().toISOString() },
  { id: "dark", relPath: sources[1], name: "Color world.png", folder: "references", size: 410000, modifiedAt: new Date().toISOString() },
  { id: "onepager", relPath: sources[2], name: "Campaign map.png", folder: "references", size: 300000, modifiedAt: new Date().toISOString() },
  { id: "xss", relPath: sources[2], name: '<img src=x onerror="window.__xss=1">.png', folder: "untrusted-downloads", size: 300000, modifiedAt: new Date().toISOString() },
];
let board = {
  version: 1,
  workspaceId: "0123456789abcdef01234567",
  rev: 3,
  viewport: { x: 105, y: 70, scale: .82 },
  selectedIds: ["asset-light"],
  nodes: [
    { id: "asset-light", kind: "asset", x: 40, y: 25, width: 390, height: 260, z: 0, relPath: sources[0], label: "Story frames" },
    { id: "note-direction", kind: "note", x: 474, y: 40, width: 275, height: 190, z: 1, text: "方向 A\n让资产、参考图和生成结果留在同一空间语境里。", tone: "amber" },
    { id: "asset-dark", kind: "asset", x: 300, y: 335, width: 390, height: 260, z: 2, relPath: sources[1], label: "Color world" },
  ],
};

const mock = `<script>
window.__xss = 0;
window.openai = { toolOutput: { workspaceId: "${board.workspaceId}", accessToken: "${accessToken}", accessState: "approved", projectName: "Campaign · Summer Launch", preferredDisplayMode: "fullscreen", displayReceiptId: "${"d".repeat(43)}" }, displayMode: "fullscreen", availableDisplayModes: ["inline", "fullscreen"] };
const __images = ${JSON.stringify(imagePayloads)};
const __assets = ${JSON.stringify(assets)};
let __board = ${JSON.stringify(board)};
let __saveCalls = 0;
let __readActive = 0;
let __maxReadActive = 0;
const __readPaths = [];
let __delayNextSave = false;
let __forceConflict = false;
let __teardown = async () => {};
const __modelContexts = [];
const __sentMessages = [];
window.visualWorkspaceMcp = {
  callServerTool: async ({ name, arguments: args }) => {
    if (name === "get_visual_workspace") return { structuredContent: structuredClone({ workspaceId: args.workspaceId, projectName: "Campaign · Summer Launch", assets: __assets, truncated: false, board: __board }) };
    if (name === "read_visual_workspace_asset") { __readPaths.push(args.relPath); __readActive += 1; __maxReadActive = Math.max(__maxReadActive, __readActive); await new Promise((resolve) => setTimeout(resolve, 35)); __readActive -= 1; return { structuredContent: structuredClone({ workspaceId: args.workspaceId, relPath: args.relPath, mimeType: "image/svg+xml", dataBase64: __images[args.relPath], size: 12000 }) }; }
    if (name === "save_visual_workspace") { __saveCalls += 1; const snapshot = structuredClone(args); if (__forceConflict) return { structuredContent: structuredClone({ conflict: true, currentBoard: __board }) }; if (__delayNextSave) { __delayNextSave = false; await new Promise((resolve) => setTimeout(resolve, 360)); } __board = { ...snapshot, version: 1, rev: snapshot.baseRev + 1, updatedAt: new Date().toISOString() }; return { structuredContent: { board: structuredClone(__board) } }; }
    if (name === "get_visual_workspace_selection") return { structuredContent: { selected: (__board.nodes || []).filter((node) => node.kind === "asset" && (__board.selectedIds || []).includes(node.id)).map((node) => ({ nodeId: node.id, label: node.label, relPath: node.relPath, absolutePath: "/qa-project/" + node.relPath })) } };
    if (name === "report_visual_workspace_display_state") return { structuredContent: { recorded: true } };
    if (name === "revoke_visual_workspace_access") return { structuredContent: { revoked: true } };
    throw new Error("Unexpected mock tool: " + name);
  },
  requestDisplayMode: async ({ mode }) => ({ mode }),
  updateModelContext: async (payload) => { __modelContexts.push(structuredClone(payload)); return {}; },
  sendMessage: async (payload) => { __sentMessages.push(structuredClone(payload)); return {}; },
  onTeardown: (handler) => { __teardown = handler; return () => {}; },
  notifyResize: () => {},
};
window.__visualQa = { get board() { return structuredClone(__board); }, get saveCalls() { return __saveCalls; }, get maxReadActive() { return __maxReadActive; }, get readPaths() { return [...__readPaths]; }, get modelContexts() { return structuredClone(__modelContexts); }, get sentMessages() { return structuredClone(__sentMessages); }, delayNextSave() { __delayNextSave = true; }, forceConflict(value) { __forceConflict = value; }, teardown: () => __teardown() };
</script>`;
html = html.replace("</head>", `${mock}</head>`);

const chromePath = [
  process.env.CHROME_PATH,
  process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "",
  process.platform === "linux" ? "/usr/bin/google-chrome" : "",
  process.platform === "linux" ? "/usr/bin/google-chrome-stable" : "",
].find((candidate) => candidate && existsSync(candidate)) || "";
const browser = await chromium.launch({
  headless: true,
  ...(chromePath && existsSync(chromePath) ? { executablePath: chromePath } : {}),
});
const reports = [];
try {
  for (const colorScheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme, reducedMotion: "no-preference" });
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#app")?.getAttribute("aria-busy") === "false");
    await page.waitForFunction(() => document.querySelectorAll(".canvas-node").length === 3);
    await page.waitForTimeout(450);

    const report = await page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const smallControls = [...document.querySelectorAll("button, input")]
        .filter(visible)
        .map((element) => ({ label: element.getAttribute("aria-label") || element.textContent.trim(), rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width < 40 || rect.height < 38)
        .map(({ label, rect }) => ({ label, width: Math.round(rect.width), height: Math.round(rect.height) }));
      const body = document.body.getBoundingClientRect();
      const focusTarget = document.querySelector("#assetSearch");
      focusTarget.focus();
      const outline = getComputedStyle(focusTarget.closest(".search-field")).boxShadow;
      const inspector = document.querySelector("#inspector").getBoundingClientRect();
      const zoom = document.querySelector(".zoom-hud").getBoundingClientRect();
      return {
        nodes: document.querySelectorAll(".canvas-node").length,
        assetCards: document.querySelectorAll(".asset-card").length,
        inspectorVisible: visible(document.querySelector("#inspector")),
        smallControls,
        overflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
        overflowY: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight,
        xss: window.__xss,
        injectedImages: document.querySelectorAll('.asset-card-copy img[onerror]').length,
        focusRing: outline,
        bodyWidth: Math.round(body.width),
        inspectorZoomOverlap: inspector.left < zoom.right && inspector.right > zoom.left && inspector.top < zoom.bottom && inspector.bottom > zoom.top,
        maxReadActive: window.__visualQa.maxReadActive,
      };
    });
    report.errors = errors;
    await page.screenshot({ path: path.join(outputDir, `native-visual-workspace-${colorScheme}.png`), fullPage: true });

    await page.click(`.asset-card[data-rel-path="${sources[1]}"]`);
    await page.waitForFunction(() => window.__visualQa.board.selectedIds?.[0] === "asset-dark" && document.querySelector("#saveStatus")?.textContent.includes("已保存"));
    await page.mouse.click(900, 650);
    await page.waitForFunction(() => window.__visualQa.board.selectedIds?.length === 0 && document.querySelector("#saveStatus")?.textContent.includes("已保存"));
    await page.click(`.asset-card[data-rel-path="${sources[0]}"]`);
    await page.waitForFunction(() => window.__visualQa.board.selectedIds?.[0] === "asset-light" && document.querySelector("#saveStatus")?.textContent.includes("已保存"));
    await page.click("#sendSelection");
    await page.waitForFunction(() => window.__visualQa.modelContexts.length === 1);
    const handoff = await page.evaluate(() => ({
      contexts: window.__visualQa.modelContexts,
      sentMessages: window.__visualQa.sentMessages,
    }));
    if (handoff.sentMessages.length || handoff.contexts[0]?.structuredContent?.visualWorkspaceSelection?.assets?.[0]?.relPath !== sources[0]) {
      throw new Error(`${colorScheme} selection handoff sent a message or lost its structured path`);
    }

    const panBefore = await page.evaluate(() => ({ viewport: window.__visualQa.board.viewport, calls: window.__visualQa.saveCalls }));
    await page.evaluate(() => window.__visualQa.delayNextSave());
    await page.click(`.asset-card[data-rel-path="${sources[1]}"]`);
    await page.waitForFunction((calls) => window.__visualQa.saveCalls > calls, panBefore.calls);
    await page.mouse.move(900, 650);
    await page.mouse.down();
    await page.mouse.move(970, 710, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector("#saveStatus")?.textContent.includes("已保存"), null, { timeout: 5000 });
    const panAfter = await page.evaluate(() => window.__visualQa.board.viewport);
    if (panAfter.x < panBefore.viewport.x + 60 || panAfter.y < panBefore.viewport.y + 50) {
      throw new Error(`${colorScheme} in-flight save discarded the newer canvas pan`);
    }

    await page.evaluate(() => window.__visualQa.delayNextSave());
    await page.dblclick('.asset-card[data-rel-path="references/campaign-map.png"]');
    await page.waitForTimeout(340);
    await page.click("#addNote");
    await page.waitForFunction(() => window.__visualQa.board.nodes.length === 5 && document.querySelector("#saveStatus")?.textContent.includes("已保存"), null, { timeout: 5000 });

    const selected = page.locator(".canvas-node.selected");
    const beforeResize = await selected.boundingBox();
    const handle = selected.locator('.resize-handle[data-direction="se"]');
    const handleBox = await handle.boundingBox();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + 80, handleBox.y + 55, { steps: 5 });
    await page.mouse.up();
    const afterResize = await selected.boundingBox();
    if (!beforeResize || !afterResize || afterResize.width <= beforeResize.width || afterResize.height <= beforeResize.height) {
      throw new Error(`${colorScheme} node resize handle did not change geometry`);
    }

    const zoomBefore = await page.locator("#zoomValue").textContent();
    await page.locator("#canvasViewport").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -120, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    });
    const zoomAfter = await page.locator("#zoomValue").textContent();
    if (zoomAfter === zoomBefore) throw new Error(`${colorScheme} pointer-anchored zoom did not update`);

    if (colorScheme === "light") {
      const savesBeforeTeardown = await page.evaluate(() => window.__visualQa.saveCalls);
      await page.click("#addNote");
      await page.evaluate(() => window.__visualQa.teardown());
      const teardownState = await page.evaluate(() => ({ saves: window.__visualQa.saveCalls, nodes: window.__visualQa.board.nodes.length }));
      if (teardownState.saves <= savesBeforeTeardown || teardownState.nodes !== 6) throw new Error(`${colorScheme} teardown did not flush the pending board`);
    } else {
      await page.evaluate(() => window.__visualQa.forceConflict(true));
      await page.click("#addNote");
      await page.waitForFunction(() => document.querySelector("#saveStatus")?.textContent.includes("另一任务"), null, { timeout: 3000 });
      const conflictCalls = await page.evaluate(() => window.__visualQa.saveCalls);
      await page.waitForTimeout(900);
      const conflictCallsLater = await page.evaluate(() => window.__visualQa.saveCalls);
      if (conflictCallsLater !== conflictCalls) throw new Error(`${colorScheme} revision conflict entered an automatic retry loop`);
      const teardownRejected = await page.evaluate(async () => {
        try { await window.__visualQa.teardown(); return false; } catch (_error) { return true; }
      });
      if (!teardownRejected) throw new Error(`${colorScheme} teardown swallowed an unsaved revision conflict`);
    }

    reports.push({ colorScheme, ...report, interaction: { resize: true, zoom: true, selectionPersistence: true, contextHandoffWithoutSend: true, panRace: true, teardownFlush: colorScheme === "light", teardownRejectsUnsaved: colorScheme === "dark", conflictStops: colorScheme === "dark" } });
    await page.close();
  }

  const reduced = await browser.newPage({ viewport: { width: 1200, height: 800 }, colorScheme: "dark", reducedMotion: "reduce" });
  await reduced.setContent(html, { waitUntil: "domcontentloaded" });
  await reduced.waitForFunction(() => document.querySelector("#app")?.getAttribute("aria-busy") === "false");
  const reducedReport = await reduced.evaluate(() => ({
    animationDuration: getComputedStyle(document.querySelector(".inspector")).animationDuration,
  }));
  await reduced.close();

  const inline = await browser.newPage({ viewport: { width: 600, height: 760 }, colorScheme: "light", reducedMotion: "no-preference" });
  await inline.setContent(html, { waitUntil: "domcontentloaded" });
  await inline.waitForFunction(() => document.querySelector("#app")?.getAttribute("aria-busy") === "false");
  await inline.evaluate(() => { document.documentElement.dataset.displayMode = "inline"; });
  await inline.waitForFunction(() => {
    const selected = document.querySelector(".asset-node.selected:not(.loading) img");
    const loadedCards = [...document.querySelectorAll(".asset-card img")].filter((image) => image.complete && image.naturalWidth > 0);
    return selected?.complete && selected.naturalWidth > 0 && loadedCards.length >= 2;
  });
  const inlineReport = await inline.evaluate(() => {
    const inspector = document.querySelector("#inspector");
    const zoom = document.querySelector(".zoom-hud");
    const inspectorRect = inspector.getBoundingClientRect();
    const zoomRect = zoom.getBoundingClientRect();
    const zoomStyle = getComputedStyle(zoom);
    return {
      overflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
      overflowY: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight,
      inspectorPosition: getComputedStyle(inspector).position,
      inspectorVisible: !inspector.hidden,
      hydratedCanvasAssets: [...document.querySelectorAll(".asset-node:not(.loading) img")].filter((image) => image.complete && image.naturalWidth > 0).length,
      selectedAssetHydrated: Boolean(document.querySelector(".asset-node.selected:not(.loading) img")?.naturalWidth),
      hydratedAssetCards: [...document.querySelectorAll(".asset-card img")].filter((image) => image.complete && image.naturalWidth > 0).length,
      zoomVisible: zoomStyle.visibility !== "hidden" && zoomStyle.display !== "none" && Number.parseFloat(zoomStyle.opacity) > 0,
      inspectorZoomOverlap: inspectorRect.left < zoomRect.right && inspectorRect.right > zoomRect.left && inspectorRect.top < zoomRect.bottom && inspectorRect.bottom > zoomRect.top,
    };
  });
  await inline.screenshot({ path: path.join(outputDir, "native-visual-workspace-inline.png"), fullPage: true });
  await inline.close();

  const consentPayload = {
    accessState: "confirmation_required",
    accessRequestId: "r".repeat(43),
    projectDir: "/Users/qa/creative-project",
    projectName: "creative-project",
    preferredDisplayMode: "fullscreen",
    displayReceiptId: "c".repeat(43),
  };
  const consentMock = `<script>
window.__consentCalls = [];
window.openai = { toolOutput: ${JSON.stringify(consentPayload)}, displayMode: "inline", availableDisplayModes: ["inline"] };
window.visualWorkspaceMcp = {
  callServerTool: async ({ name, arguments: args }) => {
    window.__consentCalls.push({ name, args: structuredClone(args) });
    if (name === "approve_visual_workspace_access") return { structuredContent: { workspaceId: "${board.workspaceId}", accessToken: "${accessToken}", accessState: "approved", projectName: "creative-project", projectRoot: "/Users/qa/creative-project" } };
    if (name === "report_visual_workspace_display_state") return { structuredContent: { recorded: true } };
    if (name === "get_visual_workspace") return { structuredContent: { workspaceId: args.workspaceId, projectName: "creative-project", assets: [], truncated: false, board: { version: 1, workspaceId: args.workspaceId, rev: 0, viewport: { x: 0, y: 0, scale: 1 }, nodes: [], selectedIds: [], updatedAt: null } } };
    throw new Error("Unexpected consent mock tool: " + name);
  },
  requestDisplayMode: async () => ({ mode: "inline" }),
  updateModelContext: async () => ({}),
  sendMessage: async () => ({}),
  onTeardown: () => () => {},
  notifyResize: () => {},
};
</script>`;
  const consentHtml = baseHtml
    .replace("/* __VISUAL_WORKSPACE_CSS__ */", css)
    .replace("/* __VISUAL_WORKSPACE_JS__ */", js)
    .replace("</head>", `${consentMock}</head>`);
  const consent = await browser.newPage({ viewport: { width: 980, height: 760 }, colorScheme: "light", reducedMotion: "no-preference" });
  const consentErrors = [];
  consent.on("console", (message) => { if (message.type() === "error") consentErrors.push(`console: ${message.text()}`); });
  consent.on("pageerror", (error) => consentErrors.push(`page: ${error.message}`));
  await consent.setContent(consentHtml, { waitUntil: "domcontentloaded" });
  await consent.waitForFunction(() => !document.querySelector("#accessGate")?.hidden && document.querySelector("#app")?.getAttribute("aria-busy") === "false");
  const beforeApproval = await consent.evaluate(() => ({
    projectPath: document.querySelector("#accessProject")?.textContent,
    displayMode: document.documentElement.dataset.displayMode,
    toast: document.querySelector("#toast")?.textContent,
    calls: structuredClone(window.__consentCalls),
  }));
  await consent.click("#approveAccess");
  await consent.waitForFunction(() => document.querySelector("#accessGate")?.hidden && document.querySelector("#saveStatus")?.textContent?.includes("已保存"));
  const afterApproval = await consent.evaluate(() => ({
    calls: structuredClone(window.__consentCalls),
    gateHidden: document.querySelector("#accessGate")?.hidden,
    projectName: document.querySelector("#projectName")?.textContent,
  }));
  const consentReport = { beforeApproval, afterApproval, errors: consentErrors };
  await consent.close();

  const lazyBoard = structuredClone(board);
  for (let index = 0; index < 80; index += 1) {
    lazyBoard.nodes.push({
      id: `offscreen-${index}`,
      kind: "asset",
      x: 20_000 + index * 420,
      y: 20_000,
      width: 320,
      height: 220,
      z: 10 + index,
      relPath: `references/offscreen-${index}.png`,
      label: `Offscreen ${index}`,
    });
  }
  const lazyHtml = html.replace(`let __board = ${JSON.stringify(board)};`, `let __board = ${JSON.stringify(lazyBoard)};`);
  const lazy = await browser.newPage({ viewport: { width: 1200, height: 800 }, colorScheme: "light" });
  await lazy.setContent(lazyHtml, { waitUntil: "domcontentloaded" });
  await lazy.waitForFunction(() => document.querySelectorAll(".canvas-node").length === 83);
  await lazy.waitForTimeout(500);
  const lazyReport = await lazy.evaluate(() => ({
    nodeCount: document.querySelectorAll(".canvas-node").length,
    offscreenReads: window.__visualQa.readPaths.filter((relPath) => relPath.includes("offscreen-")).length,
    maxReadActive: window.__visualQa.maxReadActive,
  }));
  await lazy.close();

  const seed = `<script>window.openai={toolOutput:${JSON.stringify({ workspaceId: board.workspaceId, accessToken, accessState: "approved", projectName: "Bridge Probe", preferredDisplayMode: "inline", displayReceiptId: "b".repeat(43) })},displayMode:"inline",availableDisplayModes:["inline","fullscreen"]};</script>`;
  const seededNativeWidget = inlineWidget({ html: baseHtml.replace("</head>", `${seed}</head>`), css, js });
  const host = await browser.newPage({ viewport: { width: 900, height: 700 }, colorScheme: "light" });
  const hostErrors = [];
  host.on("console", (message) => { if (message.type() === "error") hostErrors.push(`console: ${message.text()}`); });
  host.on("pageerror", (error) => hostErrors.push(`page: ${error.message}`));
  await host.setContent('<iframe id="nativeWidget" style="width:100%;height:680px;border:0"></iframe>');
  await host.evaluate(({ widget, fixtureBoard, fixtureAssets }) => {
    window.__hostProbe = { initialized: false, methods: [], displayModeRequested: "", toolCalls: [] };
    const respond = (source, id, result) => source.postMessage({ jsonrpc: "2.0", id, result }, "*");
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
      window.__hostProbe.methods.push(message.method);
      if (message.method === "ui/initialize") {
        respond(event.source, message.id, {
          protocolVersion: message.params.protocolVersion,
          hostInfo: { name: "Visual Workspace QA Host", version: "1.0.0" },
          hostCapabilities: { serverTools: {} },
          hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"], platform: "desktop" },
        });
        return;
      }
      if (message.method === "ui/notifications/initialized") {
        window.__hostProbe.initialized = true;
        return;
      }
      if (message.method === "ui/request-display-mode") {
        window.__hostProbe.displayModeRequested = message.params.mode;
        respond(event.source, message.id, { mode: message.params.mode });
        return;
      }
      if (message.method === "tools/call") {
        window.__hostProbe.toolCalls.push(message.params.name);
        const name = message.params.name;
        if (name === "get_visual_workspace") {
          respond(event.source, message.id, { content: [], structuredContent: { workspaceId: fixtureBoard.workspaceId, projectName: "Bridge Probe", assets: fixtureAssets, truncated: false, board: fixtureBoard } });
        } else if (name === "save_visual_workspace") {
          const next = { ...structuredClone(message.params.arguments), version: 1, rev: message.params.arguments.baseRev + 1, updatedAt: new Date().toISOString() };
          respond(event.source, message.id, { content: [], structuredContent: { board: next } });
        } else {
          respond(event.source, message.id, { content: [], structuredContent: {} });
        }
      }
    });
    document.querySelector("#nativeWidget").srcdoc = widget;
  }, { widget: seededNativeWidget, fixtureBoard: board, fixtureAssets: [] });
  try {
    await host.waitForFunction(() => {
      const iframe = document.querySelector("#nativeWidget");
      return window.__hostProbe.initialized && iframe?.contentDocument?.querySelector("#app")?.getAttribute("aria-busy") === "false";
    }, null, { timeout: 10000 });
  } catch (error) {
    const diagnostics = await host.evaluate(() => {
      const iframe = document.querySelector("#nativeWidget");
      return {
        probe: window.__hostProbe,
        readyState: iframe?.contentDocument?.readyState,
        appBusy: iframe?.contentDocument?.querySelector("#app")?.getAttribute("aria-busy"),
        hostError: String(iframe?.contentWindow?.__VISUAL_WORKSPACE_HOST_ERROR__?.message || iframe?.contentWindow?.__VISUAL_WORKSPACE_HOST_ERROR__ || ""),
        bodyText: iframe?.contentDocument?.body?.innerText?.slice(0, 500),
      };
    });
    throw new Error(`Native bridge handshake timed out: ${JSON.stringify({ diagnostics, hostErrors, cause: error.message })}`);
  }
  const hostReport = await host.evaluate(async () => {
    const iframe = document.querySelector("#nativeWidget");
    const teardownResult = await new Promise((resolve, reject) => {
      const requestId = 9001;
      const timer = setTimeout(() => reject(new Error("Timed out waiting for native bridge teardown")), 3000);
      const listener = (event) => {
        if (event.source !== iframe.contentWindow || event.data?.id !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", listener);
        if (event.data.error) reject(new Error(event.data.error.message));
        else resolve(event.data.result);
      };
      window.addEventListener("message", listener);
      iframe.contentWindow.postMessage({ jsonrpc: "2.0", id: requestId, method: "ui/resource-teardown", params: {} }, "*");
    });
    return {
      initialized: window.__hostProbe.initialized,
      displayModeRequested: window.__hostProbe.displayModeRequested,
      toolCalls: [...window.__hostProbe.toolCalls],
      displayModeApplied: iframe.contentDocument.documentElement.dataset.displayMode,
      bridgeInstalled: typeof iframe.contentWindow.visualWorkspaceMcp?.callServerTool === "function",
      teardownResult,
    };
  });
  await host.close();

  for (const report of reports) {
    if (report.errors.length) throw new Error(`${report.colorScheme} widget errors: ${report.errors.join(" | ")}`);
    if (report.nodes < 3 || report.assetCards !== 4 || !report.inspectorVisible) throw new Error(`${report.colorScheme} widget did not render the expected workspace`);
    if (report.smallControls.length) throw new Error(`${report.colorScheme} has undersized controls: ${JSON.stringify(report.smallControls)}`);
    if (report.overflowX > 0 || report.overflowY > 0) throw new Error(`${report.colorScheme} overflows the host viewport`);
    if (report.xss !== 0 || report.injectedImages !== 0) throw new Error(`${report.colorScheme} rendered untrusted asset names as markup`);
    if (report.inspectorZoomOverlap) throw new Error(`${report.colorScheme} inspector overlaps the zoom controls`);
    if (report.maxReadActive > 3) throw new Error(`${report.colorScheme} preview loader exceeded its concurrency limit`);
  }
  if (Number.parseFloat(reducedReport.animationDuration) > .01) throw new Error("Reduced-motion mode did not suppress animation");
  if (inlineReport.overflowX > 0 || inlineReport.overflowY > 0 || !inlineReport.inspectorVisible || inlineReport.hydratedCanvasAssets < 1 || !inlineReport.selectedAssetHydrated || inlineReport.hydratedAssetCards < 2 || inlineReport.zoomVisible || inlineReport.inspectorZoomOverlap) {
    throw new Error(`Inline layout failed: ${JSON.stringify(inlineReport)}`);
  }
  if (lazyReport.nodeCount !== 83 || lazyReport.offscreenReads !== 0 || lazyReport.maxReadActive > 3) {
    throw new Error(`Canvas preview virtualization failed: ${JSON.stringify(lazyReport)}`);
  }
  const consentApprove = consentReport.afterApproval.calls.find((call) => call.name === "approve_visual_workspace_access");
  const consentLoad = consentReport.afterApproval.calls.find((call) => call.name === "get_visual_workspace");
  const consentDisplayReport = consentReport.beforeApproval.calls.find((call) => call.name === "report_visual_workspace_display_state");
  if (consentReport.errors.length || consentReport.beforeApproval.projectPath !== consentPayload.projectDir || consentReport.beforeApproval.displayMode !== "inline" || !consentReport.beforeApproval.toast.includes("不提供全屏") || consentReport.beforeApproval.calls.length !== 1 || consentDisplayReport?.args?.outcome !== "unsupported" || consentDisplayReport?.args?.actualMode !== "inline" || !consentApprove || !consentLoad || consentLoad.args.accessToken !== accessToken || !consentReport.afterApproval.gateHidden) {
    throw new Error(`Rootless consent or declined-fullscreen flow failed: ${JSON.stringify(consentReport)}`);
  }
  if (hostErrors.length || !hostReport.initialized || hostReport.displayModeRequested !== "inline" || hostReport.displayModeApplied !== "inline" || !hostReport.bridgeInstalled || !hostReport.toolCalls.includes("report_visual_workspace_display_state") || !hostReport.toolCalls.includes("get_visual_workspace") || !hostReport.toolCalls.includes("revoke_visual_workspace_access")) {
    throw new Error(`Native MCP Apps bridge failed: ${JSON.stringify({ hostErrors, hostReport })}`);
  }
  await writeFile(path.join(outputDir, "native-visual-workspace-report.json"), `${JSON.stringify({ reports, reducedReport, inlineReport, consentReport, lazyReport, hostReport }, null, 2)}\n`);
  console.log(`OK: native widget visual QA passed in light and dark modes. Screenshots: ${outputDir}/native-visual-workspace-{light,dark}.png`);
} finally {
  await browser.close();
}
