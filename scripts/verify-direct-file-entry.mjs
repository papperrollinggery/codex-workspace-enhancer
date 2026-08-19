#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeModules = process.env.CODEX_RUNTIME_NODE_MODULES
  || path.join(root, "plugin", "codex-workspace-enhancer", "node_modules");
const { chromium } = await import(pathToFileURL(path.join(nodeModules, "playwright", "index.mjs")).href);
const entry = path.join(root, "assets", "runtime", "enhancer", "asset-console", "public", "index.html");
let browser;

try {
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  await page.goto(pathToFileURL(entry).href, { waitUntil: "load" });
  await page.locator(".direct-file-card").waitFor();
  const metrics = await page.evaluate(() => {
    const card = document.querySelector(".direct-file-card");
    const action = document.querySelector(".direct-file-primary");
    const cardStyle = getComputedStyle(card);
    const actionRect = action.getBoundingClientRect();
    return {
      title: document.title,
      heading: document.querySelector("#directFileTitle")?.textContent,
      href: action.getAttribute("href"),
      cardDisplay: cardStyle.display,
      cardRadius: cardStyle.borderRadius,
      styleSheets: document.styleSheets.length,
      giantSvgCircles: [...document.querySelectorAll("circle")].filter((circle) => {
        const rect = circle.getBoundingClientRect();
        return rect.width > 80 || rect.height > 80;
      }).length,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      actionTarget: { width: actionRect.width, height: actionRect.height },
    };
  });
  if (errors.length) throw new Error(errors.join("\n"));
  if (metrics.heading !== "这里是源码文件，不是可运行页面") throw new Error("Direct-file explanation did not render");
  if (metrics.href !== "http://127.0.0.1:5177/") throw new Error("Local-service check target is incorrect");
  if (metrics.styleSheets !== 2 || metrics.cardDisplay !== "grid") throw new Error("Direct-file entry styles did not load");
  if (metrics.giantSvgCircles !== 0 || metrics.horizontalOverflow > 0) throw new Error("Direct-file entry retained broken raw-page visuals");
  if (metrics.actionTarget.height < 40 || metrics.actionTarget.width < 40) throw new Error("Direct-file action target is too small");
  process.stdout.write(`${JSON.stringify({ ok: true, entry, metrics }, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => {});
}
