export const WORKSPACE_PANEL_EMBED_ORIGIN = "https://web-sandbox.oaiusercontent.com";
export const WORKSPACE_PANEL_EMBED_PREFIX = "/__codex_workspace_panel__/";

const STATIC_ROUTES = new Set(["/", "/index.html", "/panel.js", "/panel.css", "/module-registry.mjs"]);
const API_ROUTES = new Set([
  "/api/status",
  "/api/workspace",
  "/api/asset/read",
  "/api/board/save",
  "/api/selection",
  "/api/tasks",
  "/api/changes",
  "/api/tools",
  "/api/tools/action",
]);

export function workspacePanelEmbedPrefix(token) {
  if (!/^[a-f0-9]{32,128}$/iu.test(token || "")) throw new Error("Invalid Workspace Panel embed token");
  return `${WORKSPACE_PANEL_EMBED_PREFIX}${token}/`;
}

export function workspacePanelEmbedUrl(token) {
  return `${WORKSPACE_PANEL_EMBED_ORIGIN}${workspacePanelEmbedPrefix(token)}`;
}

export function workspacePanelRoute(requestUrl, { token, panelSession = false } = {}) {
  let url;
  try { url = new URL(requestUrl); } catch { return null; }
  if (url.origin !== WORKSPACE_PANEL_EMBED_ORIGIN) return null;
  const prefix = workspacePanelEmbedPrefix(token);
  if (!url.pathname.startsWith(prefix)) return null;
  const pathname = url.pathname.slice(prefix.length - 1) || "/";
  if (STATIC_ROUTES.has(pathname)) return `${pathname}${url.search}`;
  if (panelSession && API_ROUTES.has(pathname)) return `${pathname}${url.search}`;
  return null;
}
