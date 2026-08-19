import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";

const require = createRequire(import.meta.url);
const embeddedMcpAppsBundle = typeof __VISUAL_WORKSPACE_MCP_APPS_BUNDLE__ === "string"
  ? __VISUAL_WORKSPACE_MCP_APPS_BUNDLE__
  : "";
let cachedAppsBundle = "";

export function readText(...parts) {
  return readFileSync(path.join(...parts), "utf8");
}

export function inlineWidget({ html, css, js, initialDisplayMode = "fullscreen", appVersion = "0.0.0" }) {
  const document = html
    .replace("/* __VISUAL_WORKSPACE_CSS__ */", () => css)
    .replace("/* __VISUAL_WORKSPACE_JS__ */", () => js);
  const bridge = [
    '<script id="visualWorkspaceInitialMode">',
    `window.__VISUAL_WORKSPACE_INITIAL_MODE__=${JSON.stringify(initialDisplayMode)};`,
    "</script>",
    '<script id="visualWorkspaceMcpApps">',
    escapeInlineScript(mcpAppsBundle()),
    "</script>",
    '<script id="visualWorkspaceHostBridge">',
    hostBridgeScript(appVersion),
    "</script>",
  ].join("\n");
  return document.includes("</head>") ? document.replace("</head>", () => `${bridge}\n</head>`) : `${bridge}\n${document}`;
}

export function registerWidgetResource(server, { uri, html }) {
  const description = "A native visual workspace that requests fullscreen for arranging project images and creative notes.";
  const metadata = {
    ui: {
      prefersBorder: false,
      csp: { connectDomains: [], resourceDomains: ["data:", "blob:"] },
    },
    "openai/widgetDescription": description,
    "openai/widgetPrefersBorder": false,
    "openai/widgetCSP": {
      connect_domains: [],
      resource_domains: ["data:", "blob:"],
    },
  };
  registerAppResource(server, "visual-workspace-widget", uri, {
    title: "Visual Workspace",
    description,
    _meta: metadata,
  }, async () => ({
    contents: [{
      uri,
      mimeType: RESOURCE_MIME_TYPE,
      text: await html(),
      _meta: metadata,
    }],
  }));
}

export function createMcpAppsBundle(source) {
  const exportStart = source.lastIndexOf("export{");
  if (exportStart < 0) throw new Error("Could not locate MCP Apps browser exports");
  const match = source.slice(exportStart).match(/^export\{([^}]+)\};?\s*$/s);
  if (!match) throw new Error("Could not parse MCP Apps browser exports");
  const exports = new Map();
  for (const raw of match[1].split(",")) {
    const parts = raw.trim().split(/\s+as\s+/);
    if (parts[0]) exports.set((parts[1] || parts[0]).trim(), parts[0].trim());
  }
  const required = ["App", "applyDocumentTheme", "applyHostFonts", "applyHostStyleVariables"];
  for (const name of required) if (!exports.has(name)) throw new Error(`Missing MCP Apps browser export: ${name}`);
  return `${source.slice(0, exportStart)};globalThis.__VISUAL_WORKSPACE_MCP_APPS__={${required.map((name) => `${JSON.stringify(name)}:${exports.get(name)}`).join(",")}};`;
}

function mcpAppsBundle() {
  if (cachedAppsBundle) return cachedAppsBundle;
  if (embeddedMcpAppsBundle) {
    cachedAppsBundle = embeddedMcpAppsBundle;
    return cachedAppsBundle;
  }
  const source = readFileSync(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8");
  cachedAppsBundle = createMcpAppsBundle(source);
  return cachedAppsBundle;
}

function escapeInlineScript(source) {
  return source.replaceAll("</script", "<\\/script").replaceAll("</SCRIPT", "<\\/SCRIPT");
}

function hostBridgeScript(appVersion) {
  return `(() => {
  "use strict";
  const apps = globalThis.__VISUAL_WORKSPACE_MCP_APPS__;
  if (!apps || typeof apps.App !== "function") return;
  let hostApp = null;
  const teardownHandlers = new Set();

  const publish = (values) => {
    window.openai = Object.assign(window.openai || {}, values);
    window.dispatchEvent(new CustomEvent("openai:set_globals", { detail: { globals: window.openai } }));
  };

  const applyContext = (context) => {
    if (!context) return;
    try {
      if (context.theme) apps.applyDocumentTheme?.(context.theme);
      if (context.styles?.variables) apps.applyHostStyleVariables?.(context.styles.variables);
      if (context.styles?.css?.fonts) apps.applyHostFonts?.(context.styles.css.fonts);
    } catch (_error) {}
    if (context.displayMode) document.documentElement.dataset.displayMode = context.displayMode;
    publish({
      hostContext: context,
      displayMode: context.displayMode,
      availableDisplayModes: context.availableDisplayModes,
      widgetInstanceId: context.widgetInstanceId || context.widgetId,
    });
  };

  const size = () => ({
    width: Math.ceil(window.innerWidth || document.documentElement.clientWidth || 0),
    height: Math.ceil(Math.max(document.documentElement.scrollHeight || 0, document.body?.scrollHeight || 0)),
  });
  const notifyResize = () => { try { hostApp?.sendSizeChanged?.(size()); } catch (_error) {} };
  const withTimeout = (promise, ms, label) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); }),
    ]).finally(() => clearTimeout(timer));
  };
  const ready = async () => {
    if (hostApp?.ready) await withTimeout(hostApp.ready, 5000, "Codex widget bridge did not become ready");
    if (globalThis.__VISUAL_WORKSPACE_HOST_ERROR__) throw globalThis.__VISUAL_WORKSPACE_HOST_ERROR__;
  };

  const installApi = (app) => {
    const api = window.visualWorkspaceMcp || {};
    window.visualWorkspaceMcp = api;
    api.callServerTool = async (request, options = {}) => {
      await ready();
      return withTimeout(app.callServerTool(request, options), options.timeoutMs || 30000, "Visual Workspace tool call timed out");
    };
    api.requestDisplayMode = async (mode) => {
      await ready();
      return app.requestDisplayMode?.(typeof mode === "string" ? { mode } : mode);
    };
    api.updateModelContext = async (payload) => {
      await ready();
      if (typeof app.updateModelContext !== "function") {
        throw new Error("The Codex host does not support adding Visual Workspace selections to model context");
      }
      return withTimeout(
        Promise.resolve(app.updateModelContext(payload)),
        10000,
        "Codex host did not accept the Visual Workspace selection context",
      );
    };
    api.onTeardown = (handler) => {
      if (typeof handler !== "function") throw new Error("Teardown handler must be a function");
      teardownHandlers.add(handler);
      return () => teardownHandlers.delete(handler);
    };
    api.notifyResize = notifyResize;
  };

  const handleToolResult = (result) => {
    const metadata = result?._meta || {};
    publish({ rawToolResult: result, toolOutput: metadata.widgetData || result?.structuredContent || result || {}, toolResponseMetadata: metadata });
    notifyResize();
  };

  try {
    hostApp = new apps.App(
      { name: "visual-workspace", version: ${JSON.stringify(appVersion)} },
      { availableDisplayModes: ["inline", "fullscreen"] },
      { autoResize: true },
    );
    hostApp.onteardown = async () => {
      const outcomes = await Promise.allSettled([...teardownHandlers].map((handler) => handler()));
      const rejected = outcomes.find((outcome) => outcome.status === "rejected");
      if (rejected) throw rejected.reason;
      return {};
    };
    installApi(hostApp);
    hostApp.addEventListener("hostcontextchanged", applyContext);
    hostApp.addEventListener("toolresult", handleToolResult);
    hostApp.ready = hostApp.connect().then(() => {
      installApi(hostApp);
      applyContext(hostApp.getHostContext?.());
      publish({ hostCapabilities: hostApp.getHostCapabilities?.(), hostInfo: hostApp.getHostVersion?.() });
      notifyResize();
    }).catch((error) => { globalThis.__VISUAL_WORKSPACE_HOST_ERROR__ = error; });
  } catch (error) {
    globalThis.__VISUAL_WORKSPACE_HOST_ERROR__ = error;
  }
})();`;
}
