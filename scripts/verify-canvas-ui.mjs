#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeModules = process.env.CODEX_RUNTIME_NODE_MODULES
  || path.join(root, "plugin", "codex-workspace-enhancer", "node_modules");
const { chromium } = await import(pathToFileURL(path.join(nodeModules, "playwright", "index.mjs")).href);
const backendScript = path.join(root, "assets", "runtime", "asset-browser", "server.js");
const publicRoot = path.join(root, "assets", "runtime", "enhancer", "asset-console", "public");
const reviewRoot = path.join(root, "assets", "ui-review");
const temporary = await mkdtemp(path.join(os.tmpdir(), "asset-canvas-ui-"));
const projectRoot = path.join(temporary, "project");
const secondProjectRoot = path.join(temporary, "project-b");
const assetRoot = path.join(projectRoot, "assets");
const stateRoot = path.join(temporary, "state");
const configPath = path.join(stateRoot, "asset-browser.config.json");
const tokenPath = path.join(stateRoot, ".api-token");
const token = "c".repeat(64);
const port = 52000 + (process.pid % 1000);
let backend;
let browser;

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([typeBuffer, data])) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBuffer.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return output;
}

function makeReviewPng(variant, width = 640, height = 400) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      const nx = x / width;
      const ny = y / height;
      let red;
      let green;
      let blue;
      if (variant === "sunset") {
        red = 28 + ny * 168;
        green = 52 + ny * 70;
        blue = 94 + ny * 42;
        if ((nx - 0.72) ** 2 + (ny - 0.28) ** 2 < 0.014) [red, green, blue] = [255, 195, 108];
        const ridge = 0.67 + 0.09 * Math.sin(nx * 9) + 0.05 * Math.sin(nx * 21);
        if (ny > ridge) [red, green, blue] = [24 + nx * 24, 38 + nx * 22, 58 + nx * 30];
      } else {
        red = 26 + nx * 46;
        green = 25 + ny * 34;
        blue = 58 + (1 - nx) * 70;
        const cyan = (nx - 0.34) ** 2 + (ny - 0.52) ** 2 < 0.065;
        const amber = (nx - 0.72) ** 2 + (ny - 0.38) ** 2 < 0.038;
        if (cyan) [red, green, blue] = [39, 177 + ny * 42, 214];
        if (amber) [red, green, blue] = [238, 126 + nx * 44, 78];
        if (Math.abs(ny - (0.16 + nx * 0.72)) < 0.025) [red, green, blue] = [229, 235, 255];
      }
      const offset = 1 + x * 4;
      row[offset] = Math.round(red);
      row[offset + 1] = Math.round(green);
      row[offset + 2] = Math.round(blue);
      row[offset + 3] = 255;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        headers: { "x-asset-console-token": token },
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("AssetBrowser UI fixture did not start");
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

try {
  await mkdir(assetRoot, { recursive: true });
  await mkdir(secondProjectRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await mkdir(reviewRoot, { recursive: true });
  await writeFile(path.join(assetRoot, "cinematic-sunset.png"), makeReviewPng("sunset"));
  await writeFile(path.join(assetRoot, "material-study.png"), makeReviewPng("material"));
  await writeFile(path.join(assetRoot, "<img-onerror-test>.png"), makeReviewPng("material", 64, 40));
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  await writeFile(configPath, `${JSON.stringify({
    enabled: true,
    projects: [
      { id: "test-project", name: "视觉研究项目", path: projectRoot, scanRoots: ["assets"] },
      { id: "test-project-b", name: "第二项目", path: secondProjectRoot, scanRoots: ["."] },
    ],
  }, null, 2)}\n`);
  backend = spawn(process.execPath, [backendScript], {
    cwd: path.dirname(backendScript),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      ASSET_BROWSER_ROOT: stateRoot,
      ASSET_BROWSER_CONFIG: configPath,
      ASSET_BROWSER_TOKEN_FILE: tokenPath,
      ASSET_BROWSER_PUBLIC_ROOT: publicRoot,
    },
  });
  let backendError = "";
  backend.stderr.on("data", (chunk) => { backendError += chunk.toString(); });
  await waitForServer();

  const chromePath = [
    process.env.CHROME_PATH,
    process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "",
    process.platform === "linux" ? "/usr/bin/google-chrome" : "",
    process.platform === "linux" ? "/usr/bin/google-chrome-stable" : "",
  ].find((candidate) => candidate && existsSync(candidate)) || "";
  browser = await chromium.launch({
    headless: true,
    ...(chromePath && existsSync(chromePath) ? { executablePath: chromePath } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "light" });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  try {
    await page.locator(".asset-card").first().waitFor({ timeout: 10_000 });
  } catch (error) {
    throw new Error(`${error.message}\nUI: ${(await page.locator("body").innerText()).slice(0, 2_000)}\n${errors.join("\n")}\nBackend: ${backendError}`);
  }
  if (await page.locator("img[onerror]").count() || await page.locator("script").count() !== 1 || await page.evaluate(() => Boolean(window.__xss))) {
    throw new Error("Untrusted filename created executable markup");
  }
  await page.locator(".asset-card").filter({ hasText: "cinematic-sunset.png" }).locator(".card-select-toggle").click({ force: true });
  await page.locator(".asset-card").filter({ hasText: "material-study.png" }).locator(".card-select-toggle").click({ force: true });
  await page.locator("#batchAddToCanvas").click();
  await page.locator("#canvasWorkspace").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelectorAll(".canvas-node-asset").length === 2);
  await page.locator("#canvasAddNote").click();
  await page.waitForFunction(() => document.querySelectorAll(".canvas-node").length === 3);

  const beforeTransform = await page.locator("#canvasWorld").evaluate((element) => element.style.transform);
  const bounds = await page.locator("#canvasViewport").boundingBox();
  await page.mouse.move(bounds.x + 48, bounds.y + 48);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 128, bounds.y + 108, { steps: 4 });
  await page.mouse.up();
  const afterTransform = await page.locator("#canvasWorld").evaluate((element) => element.style.transform);
  if (beforeTransform === afterTransform) throw new Error("Canvas pan did not update the viewport transform");
  await page.locator("#canvasViewport").evaluate((element) => element.dispatchEvent(new WheelEvent("wheel", {
    deltaY: -120,
    ctrlKey: true,
    clientX: element.getBoundingClientRect().left + 400,
    clientY: element.getBoundingClientRect().top + 300,
    bubbles: true,
    cancelable: true,
  })));
  if (await page.locator("#canvasZoomValue").textContent() === "100%") throw new Error("Pointer-centered zoom did not update");

  await page.locator("#canvasFit").click();
  let delayedSave = false;
  await page.route("**/api/canvas?*", async (route) => {
    if (route.request().method() === "PUT" && !delayedSave) {
      delayedSave = true;
      await new Promise((resolve) => setTimeout(resolve, 360));
    }
    await route.continue();
  });
  const moveHandle = page.locator(".canvas-node-asset .canvas-node-bar").nth(0);
  let moveBounds = await moveHandle.boundingBox();
  await page.mouse.move(moveBounds.x + 30, moveBounds.y + 16);
  await page.mouse.down();
  await page.mouse.move(moveBounds.x + 70, moveBounds.y + 16, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(310);
  moveBounds = await moveHandle.boundingBox();
  await page.mouse.move(moveBounds.x + 30, moveBounds.y + 16);
  await page.mouse.down();
  await page.mouse.move(moveBounds.x + 90, moveBounds.y + 16, { steps: 3 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector("#canvasSaveState")?.textContent?.includes("已保存"));
  await page.waitForTimeout(700);
  const persisted = await page.evaluate(async () => (await (await fetch("/api/canvas?project=test-project")).json()).board);
  const firstNode = await page.locator(".canvas-node-asset").nth(0).evaluate((element) => ({
    id: element.dataset.nodeId,
    transform: element.style.transform,
  }));
  const persistedNode = persisted.nodes.find((node) => node.id === firstNode.id);
  const renderedX = Number(firstNode.transform.match(/translate\(([-\d.]+)px/)?.[1]);
  if (!persistedNode || Math.abs(persistedNode.x - renderedX) > 0.01) throw new Error("Latest in-flight canvas move was not persisted");

  await page.locator(".canvas-node-asset .canvas-node-bar").nth(0).click();
  await page.keyboard.down("Shift");
  await page.locator(".canvas-node-asset .canvas-node-bar").nth(1).click();
  await page.keyboard.up("Shift");
  await page.waitForFunction(() => document.querySelector("#canvasSelectionState")?.textContent?.includes("2"));
  await page.locator(".canvas-node-asset").nth(0).focus();
  await page.keyboard.press("Space");
  if (!String(await page.locator("#canvasSelectionState").textContent()).includes("1")) throw new Error("Keyboard single selection failed");
  await page.locator(".canvas-node-asset").nth(1).focus();
  await page.keyboard.down("Shift");
  await page.keyboard.press("Space");
  await page.keyboard.up("Shift");
  if (!String(await page.locator("#canvasSelectionState").textContent()).includes("2")) throw new Error("Keyboard additive selection failed");
  await page.waitForFunction(() => document.querySelector("#canvasSaveState")?.textContent?.includes("已保存"));

  const rapidNoteText = "rapid-change-before-switch";
  await page.locator(".canvas-node-note textarea").fill(rapidNoteText);
  await page.locator('[data-project-id="test-project-b"]').click();
  await page.waitForFunction(() => document.querySelector('[data-project-id="test-project-b"]')?.classList.contains("active"));
  await page.locator('[data-project-id="test-project"]').click();
  await page.waitForFunction(() => document.querySelector('[data-project-id="test-project"]')?.classList.contains("active") && document.querySelectorAll(".canvas-node").length === 3);
  if (await page.locator(".canvas-node-note textarea").inputValue() !== rapidNoteText) throw new Error("Canvas edit was lost during an immediate project switch");
  await page.locator(".canvas-node-asset .canvas-node-bar").nth(0).click();
  await page.keyboard.down("Shift");
  await page.locator(".canvas-node-asset .canvas-node-bar").nth(1).click();
  await page.keyboard.up("Shift");

  await page.screenshot({ path: path.join(reviewRoot, "asset-console-canvas-light.png"), fullPage: false });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(reviewRoot, "asset-console-canvas-dark.png"), fullPage: false });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator('[data-asset-view="canvas"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".canvas-node").length === 3);

  const metrics = await page.evaluate(() => ({
    nodes: document.querySelectorAll(".canvas-node").length,
    horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    focusOutline: getComputedStyle(document.querySelector("#canvasViewport")).outlineWidth,
    view: document.body.classList.contains("canvas-active") ? "canvas" : "grid",
    attachDisabledOutsideCodex: document.querySelector("#canvasAttachSelected")?.disabled,
    addSelectedDisabledWithoutGridSelection: document.querySelector("#canvasAddSelected")?.disabled,
    visibleGridOnlyControls: ["embeddedFilterMenu", "sortSelect", "newFolderButton", "organizeProjectButton", "selectionModeButton"].filter((id) => {
      const element = document.getElementById(id);
      return element && getComputedStyle(element).display !== "none" && element.getClientRects().length > 0;
    }),
    smallVisibleControls: [...document.querySelectorAll("button, summary, select, input")].filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const checkboxTarget = element.matches('input[type="checkbox"]') ? element.closest("label")?.getBoundingClientRect() : null;
      const effectiveWidth = checkboxTarget?.width || rect.width;
      const effectiveHeight = checkboxTarget?.height || rect.height;
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && (effectiveWidth < 40 || effectiveHeight < 40);
    }).map((element) => ({ id: element.id, text: element.textContent?.trim(), width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })),
  }));
  if (metrics.horizontalOverflow > 0) throw new Error(`Horizontal overflow: ${metrics.horizontalOverflow}px`);
  if (!metrics.attachDisabledOutsideCodex) throw new Error("Standalone canvas exposed an enabled Codex attach action");
  if (!metrics.addSelectedDisabledWithoutGridSelection) throw new Error("Canvas add action stayed enabled without a grid selection");
  if (metrics.visibleGridOnlyControls.length) throw new Error(`Grid-only controls remained visible: ${metrics.visibleGridOnlyControls.join(", ")}`);
  if (metrics.smallVisibleControls.length) throw new Error(`Visible controls below 40px: ${JSON.stringify(metrics.smallVisibleControls)}`);
  if (errors.length) throw new Error(errors.join("\n"));
  process.stdout.write(`${JSON.stringify({ ok: true, port, metrics, screenshots: [
    path.join(reviewRoot, "asset-console-canvas-light.png"),
    path.join(reviewRoot, "asset-console-canvas-dark.png"),
  ], backendError }, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => {});
  await stopProcess(backend).catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
