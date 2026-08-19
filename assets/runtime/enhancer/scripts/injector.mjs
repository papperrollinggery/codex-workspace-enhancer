#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { closeSync, existsSync, openSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import { connectMainCodex, readTargets, selectMainCodexTarget } from "./cdp-client.mjs";
import { PreviewRepository } from "../lib/preview-data.mjs";
import { presentCardPreview } from "../lib/card-view.mjs";
import { presentRateLimit } from "../lib/usage-data.mjs";
import { needsPreviewAttachment } from "../lib/injector-state.mjs";
import { buildHomeProjectShelf, readTaskboardSnapshot } from "../lib/home-projects.mjs";
import { assetBrowserRoot, resolvedTimeZone } from "../lib/platform-adapter.mjs";
import { authenticatedAssetConsoleHeaders, readAssetConsoleApiToken } from "../lib/asset-console-auth.mjs";
import { discoverInstalledVisualWorkspace, NativeWorkspaceClient } from "../lib/native-workspace-client.mjs";
import { resolvePanelContext } from "../lib/panel-context.mjs";
import { WorkspacePanelBridge } from "../lib/workspace-panel-bridge.mjs";
import {
  WORKSPACE_PANEL_EMBED_ORIGIN,
  workspacePanelEmbedPrefix,
  workspacePanelEmbedUrl,
  workspacePanelRoute,
} from "../lib/workspace-panel-embed.mjs";
import {
  ASSET_CONSOLE_EMBED_ORIGIN,
  assetConsoleEmbedPrefix,
  assetConsoleEmbedUrl,
  assetConsoleRoute,
  responseHeadersForCdp,
  transformAssetConsoleBody,
} from "../lib/asset-console-embed.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "inject", "conversation-preview.user.js");
const SCRIPT_ID_GLOBAL = "__CODEX_CONVERSATION_PREVIEW_SCRIPT_IDENTIFIER__";
const ASSET_CONSOLE_BINDING = "codexSidebarOpenAssetConsole";
const WORKSPACE_PANEL_BINDING = "codexWorkspacePanel";
const assetConsoleRoot = assetBrowserRoot();
const assetConsoleServer = assetConsoleRoot ? path.join(assetConsoleRoot, "server.js") : null;
const assetConsoleTokenPath = assetConsoleRoot ? path.join(assetConsoleRoot, ".api-token") : null;
const assetConsoleUrl = "http://127.0.0.1:5177/";
const embeddedAssetConsoleRoot = path.join(root, "asset-console", "public");
const embeddedAssetConsoleFiles = new Map([
  ["/", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/boot.js", { name: "boot.js", type: "text/javascript; charset=utf-8" }],
  ["/app.js", { name: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/ui-v3.css", { name: "ui-v3.css", type: "text/css; charset=utf-8" }],
  ["/ui-canvas.css", { name: "ui-canvas.css", type: "text/css; charset=utf-8" }],
  ["/canvas-view.mjs", { name: "canvas-view.mjs", type: "text/javascript; charset=utf-8" }],
]);
const workspacePanelRoot = path.join(root, "panel", "public");
const workspacePanelFiles = new Map([
  ["/", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/panel.js", { name: "panel.js", type: "text/javascript; charset=utf-8" }],
  ["/panel.css", { name: "panel.css", type: "text/css; charset=utf-8" }],
  ["/module-registry.mjs", { name: "module-registry.mjs", type: "text/javascript; charset=utf-8" }],
]);

async function embeddedAssetConsoleResponse(route, method) {
  if (method !== "GET") return null;
  let pathname;
  try { pathname = new URL(route, assetConsoleUrl).pathname; } catch { return null; }
  const file = embeddedAssetConsoleFiles.get(pathname);
  if (!file) return null;
  const body = await readFile(path.join(embeddedAssetConsoleRoot, file.name));
  return {
    status: 200,
    headers: { "content-type": file.type, "cache-control": "no-store" },
    body,
  };
}

async function workspacePanelResponse(route, method, body, bridge) {
  let pathname;
  try { pathname = new URL(route, WORKSPACE_PANEL_EMBED_ORIGIN).pathname; } catch { return null; }
  const file = workspacePanelFiles.get(pathname);
  if (file) {
    if (method !== "GET") return null;
    return {
      status: 200,
      headers: { "content-type": file.type, "cache-control": "no-store" },
      body: await readFile(path.join(workspacePanelRoot, file.name)),
    };
  }
  const response = await bridge.handle({ method, route, body });
  return { ...response, body: Buffer.from(response.body || "") };
}

function parseArgs(argv) {
  const options = { port: 9231, watch: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--watch") options.watch = true;
    else if (arg === "--port") options.port = Number(argv[++index]);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("Invalid port");
  return options;
}

async function targetId(port) {
  try {
    return selectMainCodexTarget(await readTargets(port))?.id || null;
  } catch {
    return null;
  }
}

const options = parseArgs(process.argv.slice(2));
const repository = new PreviewRepository();

let stopped = false;
let attachedTargetId = null;
let client = null;
let registeredScriptIdentifier = null;
let removeBindingListener = null;
let assetConsoleProxy = null;
let assetConsoleProxyQueue = Promise.resolve();
let assetConsoleStartPromise = null;
let assetConsoleChild = null;
let assetConsoleRequestGeneration = 0;
let workspacePanelProxy = null;
let workspacePanelProxyQueue = Promise.resolve();
let workspacePanelRequestGeneration = 0;
let workspacePanelBridge = null;
let workspacePluginCandidate = null;

function assetConsoleResponseLimit(route) {
  const pathname = new URL(route, assetConsoleUrl).pathname;
  return pathname === "/media" || pathname === "/download"
    ? 32 * 1024 * 1024
    : 8 * 1024 * 1024;
}

async function requestAssetConsole({ method = "GET", route = "/", headers = {}, body = null, timeoutMs = 15_000 } = {}) {
  const apiToken = await readAssetConsoleApiToken(assetConsoleTokenPath);
  return new Promise((resolve, reject) => {
    const maxResponseBytes = assetConsoleResponseLimit(route);
    const requestHeaders = authenticatedAssetConsoleHeaders(headers, apiToken);
    const request = http.request({
      hostname: "127.0.0.1",
      port: 5177,
      path: route,
      method,
      headers: requestHeaders,
    }, (response) => {
      const declaredLength = Number(response.headers["content-length"] || 0);
      if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        response.destroy();
        reject(new Error(`Asset Console response exceeds the ${Math.floor(maxResponseBytes / 1024 / 1024)} MB proxy limit`));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxResponseBytes) {
          response.destroy();
          reject(new Error(`Asset Console response exceeds the ${Math.floor(maxResponseBytes / 1024 / 1024)} MB proxy limit`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status: response.statusCode || 502,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Asset Console request timed out")));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function assetConsoleIsReady() {
  try {
    const response = await requestAssetConsole({ timeoutMs: 500 });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

async function ensureAssetConsoleServer() {
  if (await assetConsoleIsReady()) return;
  if (!assetConsoleRoot || !assetConsoleServer || !existsSync(assetConsoleServer)) {
    throw new Error("没有找到本机资产控制台服务");
  }
  if (!assetConsoleStartPromise) {
    assetConsoleStartPromise = (async () => {
      const stdoutPath = path.join(assetConsoleRoot, "asset-browser.stdout.log");
      const stderrPath = path.join(assetConsoleRoot, "asset-browser.stderr.log");
      let stdoutFd;
      let stderrFd;
      try {
        stdoutFd = openSync(stdoutPath, "a");
        stderrFd = openSync(stderrPath, "a");
        const child = spawn(process.execPath, [assetConsoleServer], {
          cwd: assetConsoleRoot,
          detached: false,
          windowsHide: true,
          stdio: ["ignore", stdoutFd, stderrFd],
          env: {
            ...process.env,
            NO_PROXY: "localhost,127.0.0.1,::1",
            no_proxy: "localhost,127.0.0.1,::1",
            HTTP_PROXY: "",
            HTTPS_PROXY: "",
            ALL_PROXY: "",
            http_proxy: "",
            https_proxy: "",
            all_proxy: "",
          },
        });
        assetConsoleChild = child;
        child.once("exit", () => {
          if (assetConsoleChild === child) assetConsoleChild = null;
        });
      } finally {
        if (stdoutFd !== undefined) closeSync(stdoutFd);
        if (stderrFd !== undefined) closeSync(stderrFd);
      }
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (await assetConsoleIsReady()) return;
      }
      throw new Error("资产控制台服务没有在 15 秒内准备完成");
    })().finally(() => { assetConsoleStartPromise = null; });
  }
  await assetConsoleStartPromise;
}

async function stopOwnedAssetConsole() {
  const child = assetConsoleChild;
  assetConsoleChild = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try { child.kill("SIGTERM"); } catch { return; }
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 2_000)),
  ]);
  if (!timedOut) return;
  try { child.kill("SIGKILL"); } catch { return; }
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
}

function queueAssetConsoleProxyWork(work) {
  const pending = assetConsoleProxyQueue.then(work, work);
  assetConsoleProxyQueue = pending.catch(() => {});
  return pending;
}

async function failAssetConsoleRequest(proxy, event, sessionId) {
  try {
    await proxy.client.send("Fetch.failRequest", {
      requestId: event.requestId,
      errorReason: "BlockedByClient",
    }, sessionId);
  } catch {}
}

async function activateAssetConsoleSession(proxy, sessionId) {
  const info = proxy.sessionInfo.get(sessionId);
  if (!info || info.active || proxy.cancelled) return;
  info.active = true;
  proxy.assetSessions.add(sessionId);
  try {
    // Once the private frame is identified, intercept every request from it so
    // the embedded app cannot use the synthetic public origin as an egress path.
    await proxy.client.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    }, sessionId);
  } catch (error) {
    info.active = false;
    proxy.assetSessions.delete(sessionId);
    throw error;
  }
}

async function proxyAssetConsoleRequest(event, sessionId, proxy) {
  if (proxy.cancelled) return failAssetConsoleRequest(proxy, event, sessionId);
  let url;
  try { url = new URL(event.request.url); } catch {
    return failAssetConsoleRequest(proxy, event, sessionId);
  }
  const isPrivateEmbedRequest = url.origin === ASSET_CONSOLE_EMBED_ORIGIN
    && url.pathname.startsWith(proxy.embedPrefix);

  if (!sessionId) {
    if (!isPrivateEmbedRequest || !event.frameId) return failAssetConsoleRequest(proxy, event, sessionId);
    if (proxy.allowedFrameId && proxy.allowedFrameId !== event.frameId) {
      return failAssetConsoleRequest(proxy, event, sessionId);
    }
    proxy.allowedFrameId = event.frameId;
    for (const [candidateSessionId, info] of proxy.sessionInfo) {
      if (info.targetId === proxy.allowedFrameId) {
        try { await activateAssetConsoleSession(proxy, candidateSessionId); } catch {}
      }
    }
  } else {
    const info = proxy.sessionInfo.get(sessionId);
    const frameMatches = Boolean(info && proxy.allowedFrameId
      && info.targetId === proxy.allowedFrameId
      && (!event.frameId || event.frameId === proxy.allowedFrameId));
    if (isPrivateEmbedRequest && !proxy.allowedFrameId && info && event.frameId === info.targetId) {
      proxy.allowedFrameId = event.frameId;
    }
    const confirmedFrame = Boolean(info && proxy.allowedFrameId
      && info.targetId === proxy.allowedFrameId
      && (!event.frameId || event.frameId === proxy.allowedFrameId));
    if (isPrivateEmbedRequest && confirmedFrame) {
      try { await activateAssetConsoleSession(proxy, sessionId); } catch {
        return failAssetConsoleRequest(proxy, event, sessionId);
      }
    } else if (!frameMatches || !proxy.assetSessions.has(sessionId)) {
      // A different sandbox frame may know the public prefix, but it never gets
      // access to localhost without both the per-open nonce and exact frame id.
      return failAssetConsoleRequest(proxy, event, sessionId);
    }
  }

  const assetSession = Boolean(sessionId && proxy.assetSessions.has(sessionId));
  const route = assetConsoleRoute(event.request.url, { token: proxy.token, assetSession });
  if (!route) {
    // The dedicated frame is fail-closed: it may only load its private static
    // files and the two local API namespaces used by Asset Console.
    if (assetSession) proxy.assetSessions.delete(sessionId);
    return failAssetConsoleRequest(proxy, event, sessionId);
  }
  try {
    const response = await embeddedAssetConsoleResponse(route, event.request.method)
      || await requestAssetConsole({
        method: event.request.method,
        route,
        headers: event.request.headers,
        body: event.request.postData || null,
      });
    const body = transformAssetConsoleBody(event.request.url, response.body, { token: proxy.token });
    await proxy.client.send("Fetch.fulfillRequest", {
      requestId: event.requestId,
      responseCode: response.status,
      responseHeaders: responseHeadersForCdp(response.headers, body.length),
      body: body.toString("base64"),
    }, sessionId);
  } catch {
    await failAssetConsoleRequest(proxy, event, sessionId);
  }
}

async function disposeAssetConsoleProxy(proxy) {
  if (!proxy || proxy.disposed) return;
  proxy.cancelled = true;
  proxy.disposed = true;
  if (assetConsoleProxy === proxy) assetConsoleProxy = null;
  proxy.removeAttachedListener?.();
  proxy.removePausedListener?.();
  try { await proxy.client.send("Fetch.disable"); } catch {}
  for (const sessionId of proxy.sessions) {
    try { await proxy.client.send("Fetch.disable", {}, sessionId); } catch {}
  }
  proxy.sessions.clear();
  proxy.assetSessions.clear();
  proxy.sessionInfo.clear();
  proxy.allowedFrameId = null;
  proxy.token = null;
  try {
    await proxy.client.send("Target.setAutoAttach", {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  } catch {}
}

async function setupAssetConsoleProxy(generation) {
  return queueAssetConsoleProxyWork(async () => {
    if (generation !== assetConsoleRequestGeneration || stopped || !client) return null;
    if (assetConsoleProxy) await disposeAssetConsoleProxy(assetConsoleProxy);
    if (generation !== assetConsoleRequestGeneration || stopped || !client) return null;

    const token = randomBytes(24).toString("hex");
    const proxy = {
      client,
      generation,
      token,
      embedPrefix: assetConsoleEmbedPrefix(token),
      embedUrl: assetConsoleEmbedUrl(token),
      allowedFrameId: null,
      sessions: new Set(),
      assetSessions: new Set(),
      sessionInfo: new Map(),
      cancelled: false,
      disposed: false,
      removeAttachedListener: null,
      removePausedListener: null,
    };
    // Publish the provisional object before the first await. A close request can
    // now cancel it even while CDP is still answering setup commands.
    assetConsoleProxy = proxy;
    proxy.removeAttachedListener = proxy.client.on("Target.attachedToTarget", async (event) => {
      const sessionId = event.sessionId;
      const targetUrl = event.targetInfo?.url || "";
      const isCandidate = Boolean(sessionId
        && event.targetInfo?.type === "iframe"
        && (!targetUrl || targetUrl.startsWith(proxy.embedUrl)));
      if (!isCandidate || proxy.cancelled) {
        if (sessionId) {
          try { await proxy.client.send("Runtime.runIfWaitingForDebugger", {}, sessionId); } catch {}
        }
        return;
      }
      proxy.sessions.add(sessionId);
      proxy.sessionInfo.set(sessionId, { targetId: event.targetInfo.targetId, active: false });
      try {
        await proxy.client.send("Fetch.enable", {
          patterns: [{ urlPattern: `${proxy.embedUrl}*`, requestStage: "Request" }],
        }, sessionId);
        if (proxy.allowedFrameId === event.targetInfo.targetId) {
          await activateAssetConsoleSession(proxy, sessionId);
        }
      } catch {}
      try { await proxy.client.send("Runtime.runIfWaitingForDebugger", {}, sessionId); } catch {}
    });
    proxy.removePausedListener = proxy.client.on("Fetch.requestPaused", (event, meta) => {
      proxyAssetConsoleRequest(event, meta.sessionId, proxy).catch(() => {});
    });

    try {
      await proxy.client.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      if (proxy.cancelled || generation !== assetConsoleRequestGeneration) {
        await disposeAssetConsoleProxy(proxy);
        return null;
      }
      await proxy.client.send("Fetch.enable", {
        patterns: [{ urlPattern: `${proxy.embedUrl}*`, requestStage: "Request" }],
      });
      if (proxy.cancelled || generation !== assetConsoleRequestGeneration) {
        await disposeAssetConsoleProxy(proxy);
        return null;
      }
      return proxy;
    } catch (error) {
      const cancelled = proxy.cancelled || generation !== assetConsoleRequestGeneration;
      await disposeAssetConsoleProxy(proxy);
      if (cancelled) return null;
      throw error;
    }
  });
}

async function teardownAssetConsoleProxy() {
  const proxy = assetConsoleProxy;
  if (proxy) proxy.cancelled = true;
  return queueAssetConsoleProxyWork(async () => {
    if (proxy) await disposeAssetConsoleProxy(proxy);
  });
}

function queueWorkspacePanelProxyWork(work) {
  const pending = workspacePanelProxyQueue.then(work, work);
  workspacePanelProxyQueue = pending.catch(() => {});
  return pending;
}

async function failWorkspacePanelRequest(proxy, event, sessionId) {
  try {
    await proxy.client.send("Fetch.failRequest", {
      requestId: event.requestId,
      errorReason: "BlockedByClient",
    }, sessionId);
  } catch {}
}

async function activateWorkspacePanelSession(proxy, sessionId) {
  const info = proxy.sessionInfo.get(sessionId);
  if (!info || info.active || proxy.cancelled) return;
  info.active = true;
  proxy.panelSessions.add(sessionId);
  try {
    await proxy.client.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    }, sessionId);
  } catch (error) {
    info.active = false;
    proxy.panelSessions.delete(sessionId);
    throw error;
  }
}

async function proxyWorkspacePanelRequest(event, sessionId, proxy) {
  if (proxy.cancelled) return failWorkspacePanelRequest(proxy, event, sessionId);
  let url;
  try { url = new URL(event.request.url); } catch {
    return failWorkspacePanelRequest(proxy, event, sessionId);
  }
  const isPrivateEmbedRequest = url.origin === WORKSPACE_PANEL_EMBED_ORIGIN
    && url.pathname.startsWith(proxy.embedPrefix);

  if (!sessionId) {
    if (!isPrivateEmbedRequest || !event.frameId) return failWorkspacePanelRequest(proxy, event, sessionId);
    if (proxy.allowedFrameId && proxy.allowedFrameId !== event.frameId) {
      return failWorkspacePanelRequest(proxy, event, sessionId);
    }
    proxy.allowedFrameId = event.frameId;
    for (const [candidateSessionId, info] of proxy.sessionInfo) {
      if (info.targetId === proxy.allowedFrameId) {
        try { await activateWorkspacePanelSession(proxy, candidateSessionId); } catch {}
      }
    }
  } else {
    const info = proxy.sessionInfo.get(sessionId);
    const frameMatches = Boolean(info && proxy.allowedFrameId
      && info.targetId === proxy.allowedFrameId
      && (!event.frameId || event.frameId === proxy.allowedFrameId));
    if (isPrivateEmbedRequest && !proxy.allowedFrameId && info && event.frameId === info.targetId) {
      proxy.allowedFrameId = event.frameId;
    }
    const confirmedFrame = Boolean(info && proxy.allowedFrameId
      && info.targetId === proxy.allowedFrameId
      && (!event.frameId || event.frameId === proxy.allowedFrameId));
    if (isPrivateEmbedRequest && confirmedFrame) {
      try { await activateWorkspacePanelSession(proxy, sessionId); } catch {
        return failWorkspacePanelRequest(proxy, event, sessionId);
      }
    } else if (!frameMatches || !proxy.panelSessions.has(sessionId)) {
      return failWorkspacePanelRequest(proxy, event, sessionId);
    }
  }

  const panelSession = Boolean(sessionId && proxy.panelSessions.has(sessionId));
  const route = workspacePanelRoute(event.request.url, { token: proxy.token, panelSession });
  if (!route) {
    if (panelSession) proxy.panelSessions.delete(sessionId);
    return failWorkspacePanelRequest(proxy, event, sessionId);
  }
  try {
    const response = await workspacePanelResponse(
      route,
      event.request.method,
      event.request.postData || "",
      proxy.bridge,
    );
    if (!response) return failWorkspacePanelRequest(proxy, event, sessionId);
    await proxy.client.send("Fetch.fulfillRequest", {
      requestId: event.requestId,
      responseCode: response.status,
      responseHeaders: responseHeadersForCdp(response.headers, response.body.length),
      body: response.body.toString("base64"),
    }, sessionId);
  } catch {
    await failWorkspacePanelRequest(proxy, event, sessionId);
  }
}

async function disposeWorkspacePanelProxy(proxy) {
  if (!proxy || proxy.disposed) return;
  proxy.cancelled = true;
  proxy.disposed = true;
  if (workspacePanelProxy === proxy) workspacePanelProxy = null;
  if (workspacePanelBridge === proxy.bridge) workspacePanelBridge = null;
  proxy.removeAttachedListener?.();
  proxy.removePausedListener?.();
  try { await proxy.client.send("Fetch.disable"); } catch {}
  for (const sessionId of proxy.sessions) {
    try { await proxy.client.send("Fetch.disable", {}, sessionId); } catch {}
  }
  proxy.sessions.clear();
  proxy.panelSessions.clear();
  proxy.sessionInfo.clear();
  proxy.allowedFrameId = null;
  proxy.token = null;
  try {
    await proxy.client.send("Target.setAutoAttach", {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  } catch {}
  await proxy.bridge.close().catch(() => {});
}

async function setupWorkspacePanelProxy(generation, bridge) {
  return queueWorkspacePanelProxyWork(async () => {
    if (generation !== workspacePanelRequestGeneration || stopped || !client) return null;
    if (workspacePanelProxy) await disposeWorkspacePanelProxy(workspacePanelProxy);
    if (generation !== workspacePanelRequestGeneration || stopped || !client) return null;

    const token = randomBytes(24).toString("hex");
    const proxy = {
      client,
      bridge,
      generation,
      token,
      embedPrefix: workspacePanelEmbedPrefix(token),
      embedUrl: workspacePanelEmbedUrl(token),
      allowedFrameId: null,
      sessions: new Set(),
      panelSessions: new Set(),
      sessionInfo: new Map(),
      cancelled: false,
      disposed: false,
      removeAttachedListener: null,
      removePausedListener: null,
    };
    workspacePanelProxy = proxy;
    workspacePanelBridge = bridge;
    proxy.removeAttachedListener = proxy.client.on("Target.attachedToTarget", async (event) => {
      const sessionId = event.sessionId;
      const targetUrl = event.targetInfo?.url || "";
      const isCandidate = Boolean(sessionId
        && event.targetInfo?.type === "iframe"
        && (!targetUrl || targetUrl.startsWith(proxy.embedUrl)));
      if (!isCandidate || proxy.cancelled) {
        if (sessionId) {
          try { await proxy.client.send("Runtime.runIfWaitingForDebugger", {}, sessionId); } catch {}
        }
        return;
      }
      proxy.sessions.add(sessionId);
      proxy.sessionInfo.set(sessionId, { targetId: event.targetInfo.targetId, active: false });
      try {
        await proxy.client.send("Fetch.enable", {
          patterns: [{ urlPattern: `${proxy.embedUrl}*`, requestStage: "Request" }],
        }, sessionId);
        if (proxy.allowedFrameId === event.targetInfo.targetId) {
          await activateWorkspacePanelSession(proxy, sessionId);
        }
      } catch {}
      try { await proxy.client.send("Runtime.runIfWaitingForDebugger", {}, sessionId); } catch {}
    });
    proxy.removePausedListener = proxy.client.on("Fetch.requestPaused", (event, meta) => {
      proxyWorkspacePanelRequest(event, meta.sessionId, proxy).catch(() => {});
    });

    try {
      await proxy.client.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      if (proxy.cancelled || generation !== workspacePanelRequestGeneration) {
        await disposeWorkspacePanelProxy(proxy);
        return null;
      }
      await proxy.client.send("Fetch.enable", {
        patterns: [{ urlPattern: `${proxy.embedUrl}*`, requestStage: "Request" }],
      });
      if (proxy.cancelled || generation !== workspacePanelRequestGeneration) {
        await disposeWorkspacePanelProxy(proxy);
        return null;
      }
      return proxy;
    } catch (error) {
      const cancelled = proxy.cancelled || generation !== workspacePanelRequestGeneration;
      await disposeWorkspacePanelProxy(proxy);
      if (cancelled) return null;
      throw error;
    }
  });
}

async function teardownWorkspacePanelProxy() {
  const proxy = workspacePanelProxy;
  if (proxy) proxy.cancelled = true;
  return queueWorkspacePanelProxyWork(async () => {
    if (proxy) await disposeWorkspacePanelProxy(proxy);
  });
}

async function handleAssetConsoleBinding(payload) {
  let message = {};
  try { message = JSON.parse(payload || "{}"); } catch {}
  const generation = ++assetConsoleRequestGeneration;
  if (message.action === "close") {
    await teardownAssetConsoleProxy();
    return;
  }
  try {
    await ensureAssetConsoleServer();
    if (generation !== assetConsoleRequestGeneration) return;
    const proxy = await setupAssetConsoleProxy(generation);
    if (!proxy) return;
    if (generation !== assetConsoleRequestGeneration) return;
    const embedUrl = new URL(proxy.embedUrl);
    embedUrl.searchParams.set("embed", "codex");
    if (typeof message.threadId === "string" && message.threadId.length <= 160) {
      embedUrl.searchParams.set("threadId", message.threadId);
    }
    if (typeof message.threadTitle === "string" && message.threadTitle.length <= 300) {
      embedUrl.searchParams.set("threadTitle", message.threadTitle);
    }
    await client.evaluate(`window.__codexConversationPreviewInjection__?.setAssetConsolePanel?.(${JSON.stringify({
      state: "ready",
      url: embedUrl.href,
    })})`);
  } catch (error) {
    if (generation !== assetConsoleRequestGeneration) return;
    await teardownAssetConsoleProxy();
    try {
      await client.evaluate(`window.__codexConversationPreviewInjection__?.setAssetConsolePanel?.(${JSON.stringify({
        state: "error",
        message: error?.message || "资产控制台加载失败",
      })})`);
    } catch {}
  }
}

async function handleWorkspacePanelBinding(payload) {
  let message = {};
  try { message = JSON.parse(payload || "{}"); } catch {}
  if (message.panel !== "workspace") return;
  const generation = ++workspacePanelRequestGeneration;
  if (message.action === "close") {
    await teardownWorkspacePanelProxy();
    return;
  }
  if (message.action !== "open") return;

  let nativeClient = null;
  try {
    await teardownAssetConsoleProxy();
    await teardownWorkspacePanelProxy();
    if (generation !== workspacePanelRequestGeneration) return;
    const context = await resolvePanelContext({ threadId: message.threadId });
    if (!context) throw new Error("无法从当前 Codex 任务确认项目目录");
    workspacePluginCandidate ||= await discoverInstalledVisualWorkspace({
      explicitServerPath: process.env.CODEX_VISUAL_WORKSPACE_SERVER,
    });
    nativeClient = new NativeWorkspaceClient(workspacePluginCandidate);
    const openResult = await nativeClient.openApprovedWorkspace({
      projectDir: context.projectDir,
      displayMode: "inline",
    });
    if (generation !== workspacePanelRequestGeneration) {
      await nativeClient.close();
      return;
    }
    const bridge = new WorkspacePanelBridge({
      context,
      openResult,
      nativeClient,
      version: workspacePluginCandidate.version,
      actionHandler: (actionId) => client.evaluate(
        `window.__codexConversationPreviewInjection__?.runWorkspaceToolAction?.(${JSON.stringify(actionId)}) || { action: "unavailable", sent: false }`,
      ),
    });
    nativeClient = null;
    const proxy = await setupWorkspacePanelProxy(generation, bridge);
    if (!proxy) {
      await bridge.close();
      return;
    }
    const embedUrl = new URL(proxy.embedUrl);
    embedUrl.searchParams.set("embed", "codex");
    await client.evaluate(`window.__codexConversationPreviewInjection__?.setWorkspacePanelFrame?.(${JSON.stringify({
      state: "ready",
      url: embedUrl.href,
      accessState: openResult.accessState,
    })})`);
  } catch (error) {
    await nativeClient?.close().catch(() => {});
    if (generation !== workspacePanelRequestGeneration) return;
    await teardownWorkspacePanelProxy();
    try {
      await client.evaluate(`window.__codexConversationPreviewInjection__?.setWorkspacePanelFrame?.(${JSON.stringify({
        state: "error",
        message: error?.message || "工作面板加载失败",
      })})`);
    } catch {}
  }
}

async function bindWorkspaceIntegrations() {
  removeBindingListener?.();
  removeBindingListener = null;
  const assetAvailable = Boolean(assetConsoleServer && existsSync(assetConsoleServer));
  try {
    workspacePluginCandidate = await discoverInstalledVisualWorkspace({
      explicitServerPath: process.env.CODEX_VISUAL_WORKSPACE_SERVER,
    });
  } catch {
    workspacePluginCandidate = null;
  }
  const workspaceAvailable = Boolean(workspacePluginCandidate);
  if (assetAvailable || workspaceAvailable) {
    await client.send("Runtime.enable");
    try { await client.send("Runtime.removeBinding", { name: ASSET_CONSOLE_BINDING }); } catch {}
    try { await client.send("Runtime.removeBinding", { name: WORKSPACE_PANEL_BINDING }); } catch {}
    if (assetAvailable) await client.send("Runtime.addBinding", { name: ASSET_CONSOLE_BINDING });
    if (workspaceAvailable) await client.send("Runtime.addBinding", { name: WORKSPACE_PANEL_BINDING });
    removeBindingListener = client.on("Runtime.bindingCalled", ({ name, payload }) => {
      if (name === ASSET_CONSOLE_BINDING) handleAssetConsoleBinding(payload).catch(() => {});
      if (name === WORKSPACE_PANEL_BINDING) handleWorkspacePanelBinding(payload).catch(() => {});
    });
  }
  await client.evaluate(`window.__codexConversationPreviewInjection__?.setAssetConsole?.(${JSON.stringify({
    available: assetAvailable,
    label: "资产控制台",
    mode: "embedded",
  })})`);
  await client.evaluate(`window.__codexConversationPreviewInjection__?.setWorkspacePanel?.(${JSON.stringify({
    available: workspaceAvailable,
    label: "工作面板",
    mode: "native-mcp",
  })})`);
}

async function attach() {
  const nextTargetId = await targetId(options.port);
  if (!await needsPreviewAttachment({ client, attachedTargetId, nextTargetId })) return false;

  if (!client || nextTargetId !== attachedTargetId) {
    assetConsoleRequestGeneration += 1;
    workspacePanelRequestGeneration += 1;
    await teardownAssetConsoleProxy();
    await teardownWorkspacePanelProxy();
    client?.close();
    client = await connectMainCodex(options.port);
    removeBindingListener = null;
    registeredScriptIdentifier = null;
  }

  const oldIdentifier = registeredScriptIdentifier
    || await client.evaluate(`window[${JSON.stringify(SCRIPT_ID_GLOBAL)}] || null`);
  if (oldIdentifier) {
    try { await client.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: oldIdentifier }); } catch {}
  }
  const userSource = await readFile(sourcePath, "utf8");
  const registered = await client.send("Page.addScriptToEvaluateOnNewDocument", { source: userSource });
  registeredScriptIdentifier = registered.identifier;
  await client.evaluate(userSource);
  await client.evaluate(`window[${JSON.stringify(SCRIPT_ID_GLOBAL)}] = ${JSON.stringify(registered.identifier)}`);
  await bindWorkspaceIntegrations();
  attachedTargetId = nextTargetId;
  process.stdout.write(`Codex conversation preview attached to renderer ${nextTargetId}\n`);
  return true;
}

async function pushPreviews() {
  if (!client || !attachedTargetId) return;
  const [requests, homeProjectState] = await Promise.all([
    client.evaluate(`(() => {
      const seen = new Set();
      return Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-row]')).flatMap((row) => {
        const id = row.getAttribute('data-app-action-sidebar-thread-id') || '';
        const title = row.getAttribute('data-app-action-sidebar-thread-title') || '';
        const key = id + '\\n' + title;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ key, id, title }];
      });
    })()`),
    client.evaluate("window.__codexConversationPreviewInjection__?.getHomeProjectsState?.() || null"),
  ]);
  const [rawPreviews, rawUsage, taskboard, searchCatalog] = await Promise.all([
    repository.readMany(Array.isArray(requests) ? requests : []),
    repository.readUsage(),
    readTaskboardSnapshot(),
    repository.readSearchCatalog(),
  ]);
  const previews = rawPreviews.map((preview) => presentCardPreview(preview));
  const usage = presentRateLimit(rawUsage, { timeZone: resolvedTimeZone() });
  const homeProjects = taskboard.available
    ? {
        available: true,
        message: "",
        ...buildHomeProjectShelf({
          projects: taskboard.projects,
          tasks: taskboard.tasks,
          state: homeProjectState,
          syncedAt: new Date().toISOString(),
        }),
      }
    : {
        available: false,
        message: taskboard.message,
        cards: [],
        state: homeProjectState,
      };
  await client.evaluate(`(() => {
    const api = window.__codexConversationPreviewInjection__;
    api?.setPreviews?.(${JSON.stringify(previews)});
    api?.setUsage?.(${JSON.stringify(usage)});
    api?.setHomeProjects?.(${JSON.stringify(homeProjects)});
    api?.setSearchCatalog?.(${JSON.stringify(searchCatalog)});
  })()`);
}

async function stop() {
  if (stopped) return;
  stopped = true;
  try { await client?.evaluate("window.__codexConversationPreviewInjection__?.destroy?.()") } catch {}
  assetConsoleRequestGeneration += 1;
  workspacePanelRequestGeneration += 1;
  await teardownAssetConsoleProxy();
  await teardownWorkspacePanelProxy();
  removeBindingListener?.();
  removeBindingListener = null;
  client?.close();
  await stopOwnedAssetConsole();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await stop();
    process.exit(0);
  });
}

try {
  while (!stopped) {
    try {
      await attach();
      await pushPreviews();
    } catch (error) {
      attachedTargetId = null;
      registeredScriptIdentifier = null;
      assetConsoleRequestGeneration += 1;
      workspacePanelRequestGeneration += 1;
      await teardownAssetConsoleProxy();
      await teardownWorkspacePanelProxy();
      client?.close();
      client = null;
      if (!options.watch) throw error;
    }
    if (!options.watch) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
} finally {
  if (!options.watch) await stop();
}
