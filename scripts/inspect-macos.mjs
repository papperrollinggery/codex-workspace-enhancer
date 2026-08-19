#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const home = os.homedir();
const debugPort = Number(process.env.CODEX_DEBUG_PORT || 9231);
const backendPort = Number(process.env.ASSET_BROWSER_PORT || 5177);
const roots = {
  enhancer: path.join(home, "Library", "Application Support", "Codex Sidebar Enhancer"),
  state: path.join(home, "Library", "Application Support", "CodexSidebarEnhancer"),
  assetBrowser: path.join(home, "Library", "Application Support", "AssetBrowser"),
  launcher: path.join(home, "Applications", "Codex Sidebar Enhancer.app"),
  launchAgent: path.join(home, "Library", "LaunchAgents", "com.yubowen.codex-sidebar-enhancer.plist"),
};

function plistValue(appPath, key) {
  try {
    return execFileSync("/usr/bin/defaults", ["read", path.join(appPath, "Contents", "Info"), key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function inspectDesktopApp() {
  for (const appPath of ["/Applications/ChatGPT.app", "/Applications/Codex.app"]) {
    if (!existsSync(appPath)) continue;
    return {
      found: true,
      path: appPath,
      bundleIdentifier: plistValue(appPath, "CFBundleIdentifier"),
      version: plistValue(appPath, "CFBundleShortVersionString"),
      executable: plistValue(appPath, "CFBundleExecutable"),
    };
  }
  return { found: false, path: null, bundleIdentifier: null, version: null, executable: null };
}

function requestJson(port, pathname, headers = {}) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: pathname, headers, timeout: 1_000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({ reachable: true, status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch {
          resolve({ reachable: true, status: response.statusCode, body: null });
        }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve({ reachable: false, status: null, body: null }));
  });
}

function launchAgentState() {
  const label = `gui/${process.getuid()}/com.yubowen.codex-sidebar-enhancer`;
  const result = spawnSync("/bin/launchctl", ["print", label], { encoding: "utf8" });
  return { loaded: result.status === 0, label };
}

const tokenPath = path.join(roots.assetBrowser, ".api-token");
const token = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "";
const [debug, backend] = await Promise.all([
  requestJson(debugPort, "/json"),
  requestJson(backendPort, "/api/projects", token ? { "x-asset-console-token": token } : {}),
]);

const result = {
  inspectedAt: new Date().toISOString(),
  platform: { os: process.platform, arch: process.arch, release: os.release() },
  node: { version: process.version, compatible: Number(process.versions.node.split(".")[0]) >= 22 },
  desktopApp: inspectDesktopApp(),
  debug: {
    port: debugPort,
    reachable: debug.reachable,
    targetCount: Array.isArray(debug.body) ? debug.body.length : 0,
    targets: Array.isArray(debug.body)
      ? debug.body.map(({ id, type, title, url }) => ({ id, type, title, url }))
      : [],
  },
  install: Object.fromEntries(Object.entries(roots).map(([name, value]) => [name, { path: value, present: existsSync(value) }])),
  launchAgent: launchAgentState(),
  assetBrowser: {
    port: backendPort,
    reachable: backend.reachable,
    authenticated: backend.status === 200,
    projectCount: Array.isArray(backend.body?.projects) ? backend.body.projects.length : null,
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (process.platform !== "darwin" || !result.node.compatible || !result.desktopApp.found) process.exitCode = 1;
