import { PanelModuleRegistry } from "./module-registry.mjs";

const PRIMARY_MODULES = ["overview", "assets", "canvas"];
const MAX_PREVIEW_CACHE_BYTES = 48 * 1024 * 1024;
const MAX_PREVIEW_CACHE_ENTRIES = 24;
const PREVIEW_CONCURRENCY = 3;
const MAX_CANVAS_PREVIEWS = 12;

const elements = {
  app: document.querySelector("#panelApp"),
  title: document.querySelector("#panelTitle"),
  context: document.querySelector("#panelContext"),
  connection: document.querySelector("#connectionState"),
  tabs: document.querySelector("#panelTabs"),
  content: document.querySelector("#panelContent"),
  status: document.querySelector("#panelStatus"),
};

const state = {
  active: "overview",
  generation: 0,
  status: null,
  workspace: null,
  previewCache: new Map(),
  previewPromises: new Map(),
  previewObservers: new Set(),
  previewQueue: [],
  previewQueued: new WeakSet(),
  previewActive: 0,
  previewBytes: 0,
  disposed: false,
};
let overviewRefreshTimer = null;

async function api(route, options = {}) {
  const response = await fetch(route, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `工作台请求失败 (${response.status})`);
  return payload;
}

function node(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== "") element.textContent = String(text);
  return element;
}

function icon(name) {
  const svg = node("span", "ui-icon");
  const paths = {
    overview: '<rect x="3" y="3" width="6" height="6" rx="1.2"/><rect x="11" y="3" width="6" height="6" rx="1.2"/><rect x="3" y="11" width="6" height="6" rx="1.2"/><path d="M12 12h4M12 15h4"/>',
    assets: '<rect x="3" y="4" width="14" height="12" rx="2"/><path d="m5.5 13 3-3 2.2 2.1 1.7-1.8 2.2 2.7M7 7.5h.01"/>',
    canvas: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14.5z"/><path d="M7 8h2v2H7zM11 10h2v2h-2zM8 13h2"/>',
    arrow: '<path d="M5 10h10M11 6l4 4-4 4"/>',
    task: '<path d="M5 3.5h10v13H5zM7.5 7h5M7.5 10h5M7.5 13h3"/>',
    search: '<circle cx="9" cy="9" r="5"/><path d="m13 13 3.5 3.5"/>',
  };
  svg.innerHTML = `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">${paths[name] || paths.arrow}</svg>`;
  return svg;
}

function setStatus(message, tone = "ready") {
  elements.status.textContent = message;
  elements.app.dataset.statusTone = tone;
}

function setConnection(label, tone) {
  const dot = node("i");
  dot.setAttribute("aria-hidden", "true");
  elements.connection.replaceChildren(dot, document.createTextNode(label));
  elements.connection.dataset.tone = tone;
}

function chip(label, tone = "neutral") {
  const element = node("span", "context-chip", label);
  element.dataset.tone = tone;
  return element;
}

function sectionHeading(title, meta = "") {
  const header = node("header", "section-heading");
  header.append(node("h2", "", title));
  if (meta) header.append(node("span", "section-meta", meta));
  return header;
}

function emptyState(title, detail) {
  const wrapper = node("div", "panel-empty");
  wrapper.append(icon("assets"), node("strong", "", title), node("span", "", detail));
  return wrapper;
}

function actionButton(label, action, { primary = false, iconName = "arrow" } = {}) {
  const button = node("button", primary ? "action-button primary" : "action-button");
  button.type = "button";
  button.append(node("span", "", label), icon(iconName));
  button.addEventListener("click", action);
  return button;
}

function previewEntry(relPath) {
  const entry = state.previewCache.get(relPath);
  if (!entry) return null;
  entry.lastUsed = Date.now();
  return entry.url;
}

function visiblePreviewPaths() {
  const rootRect = elements.content.getBoundingClientRect();
  return new Set([...elements.content.querySelectorAll("img[data-preview-path]")].flatMap((image) => {
    const rect = image.getBoundingClientRect();
    return rect.bottom >= rootRect.top && rect.top <= rootRect.bottom ? [image.dataset.previewPath] : [];
  }));
}

function releasePreview(relPath, entry) {
  for (const image of elements.content.querySelectorAll("img[data-preview-path]")) {
    if (image.dataset.previewPath !== relPath || image.src !== entry.url) continue;
    image.removeAttribute("src");
    image.closest(".asset-tile, .canvas-node")?.classList.add("is-loading");
  }
  URL.revokeObjectURL(entry.url);
}

function evictPreviewCache(protectedPath = "") {
  while (state.previewCache.size > MAX_PREVIEW_CACHE_ENTRIES || state.previewBytes > MAX_PREVIEW_CACHE_BYTES) {
    const visible = visiblePreviewPaths();
    const candidates = [...state.previewCache.entries()]
      .filter(([relPath]) => relPath !== protectedPath)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    const candidate = candidates.find(([relPath]) => !visible.has(relPath)) || candidates[0];
    if (!candidate) return;
    const [relPath, entry] = candidate;
    state.previewCache.delete(relPath);
    state.previewBytes -= entry.bytes;
    releasePreview(relPath, entry);
  }
}

function resetPreviewScheduling() {
  for (const observer of state.previewObservers) observer.disconnect();
  state.previewObservers.clear();
  state.previewQueue.length = 0;
  state.previewQueued = new WeakSet();
}

function previewBlobUrl(mimeType, dataBase64) {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { bytes: bytes.byteLength, url: URL.createObjectURL(new Blob([bytes], { type: mimeType })) };
}

async function loadPreview(relPath) {
  if (state.disposed) throw new Error("工作面板已关闭");
  const cached = previewEntry(relPath);
  if (cached) return cached;
  if (state.previewPromises.has(relPath)) return state.previewPromises.get(relPath);
  const promise = (async () => {
    const payload = await api("./api/asset/read", {
      method: "POST",
      body: JSON.stringify({ relPath }),
    });
    if (!/^image\/(?:avif|gif|jpeg|png|webp)$/u.test(payload.mimeType || "") || typeof payload.dataBase64 !== "string") {
      throw new Error("图片预览格式无效");
    }
    if (state.disposed) throw new Error("工作面板已关闭");
    const { bytes, url } = previewBlobUrl(payload.mimeType, payload.dataBase64);
    state.previewCache.set(relPath, { url, bytes, lastUsed: Date.now() });
    state.previewBytes += bytes;
    evictPreviewCache(relPath);
    return url;
  })().finally(() => state.previewPromises.delete(relPath));
  state.previewPromises.set(relPath, promise);
  return promise;
}

function pumpPreviewQueue() {
  while (state.previewActive < PREVIEW_CONCURRENCY && state.previewQueue.length) {
    const job = state.previewQueue.shift();
    if (job.generation !== state.generation || !job.image.isConnected) {
      state.previewQueued.delete(job.image);
      continue;
    }
    state.previewActive += 1;
    const relPath = job.image.dataset.previewPath;
    void loadPreview(relPath).then((url) => {
      if (job.generation !== state.generation || !job.image.isConnected) return;
      job.image.src = url;
      job.image.closest(".asset-tile, .canvas-node")?.classList.remove("is-loading");
    }).catch(() => {
      job.image.closest(".asset-tile, .canvas-node")?.classList.add("preview-error");
    }).finally(() => {
      state.previewActive -= 1;
      state.previewQueued.delete(job.image);
      pumpPreviewQueue();
    });
  }
}

function enqueuePreview(image, generation) {
  if (state.disposed || state.previewQueued.has(image)) return;
  const cached = previewEntry(image.dataset.previewPath);
  if (cached) {
    image.src = cached;
    image.closest(".asset-tile, .canvas-node")?.classList.remove("is-loading");
    return;
  }
  state.previewQueued.add(image);
  state.previewQueue.push({ image, generation });
  pumpPreviewQueue();
}

async function hydrateImages(root, generation) {
  const images = [...root.querySelectorAll("img[data-preview-path]")];
  if (typeof IntersectionObserver !== "function") {
    images.slice(0, 12).forEach((image) => enqueuePreview(image, generation));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      enqueuePreview(entry.target, generation);
    }
  }, { root: elements.content, rootMargin: "240px 0px" });
  state.previewObservers.add(observer);
  for (const image of images) observer.observe(image);
}

async function addAssetToCanvas(asset, button) {
  const board = state.workspace?.board;
  if (!board) return setStatus("画布状态尚未载入", "warning");
  if (!Number.isInteger(board.rev) || board.rev < 0) return setStatus("画布 revision 无效，请刷新后重试", "error");
  button.disabled = true;
  setStatus(`正在把 ${asset.name || asset.relPath} 加入画布`, "loading");
  try {
    const existing = board.nodes?.find((item) => item.kind === "asset" && item.relPath === asset.relPath);
    const bounds = boardBounds(board.nodes || []);
    const positionIndex = board.nodes?.length || 0;
    const nodes = existing ? board.nodes.map((item) => ({ ...item })) : [
      ...(board.nodes || []).map((item) => ({ ...item })),
      {
        id: `panel-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
        kind: "asset",
        x: bounds.left + (positionIndex % 3) * 340,
        y: bounds.top + Math.floor(positionIndex / 3) * 240,
        width: 320,
        height: 220,
        z: Math.max(-1, ...(board.nodes || []).map((item) => Number(item.z) || 0)) + 1,
        relPath: asset.relPath,
        label: asset.name || asset.relPath.split("/").at(-1),
      },
    ];
    const selectedId = existing?.id || nodes.at(-1).id;
    const response = await api("./api/board/save", {
      method: "POST",
      body: JSON.stringify({
        baseRev: board.rev,
        viewport: board.viewport || { x: 0, y: 0, scale: 1 },
        nodes,
        selectedIds: [selectedId],
      }),
    });
    if (response.conflict) {
      state.workspace.board = response.currentBoard;
      await activate(state.active);
      throw new Error("画布已在另一个视图更新，请刷新后重试");
    }
    if (!response.board || !Number.isInteger(response.board.rev)) throw new Error("画布保存回执无效");
    state.workspace.board = response.board;
    button.textContent = "已在画布";
    button.closest(".asset-tile")?.setAttribute("data-on-canvas", "true");
    const message = existing ? `${asset.name || asset.relPath} 已在画布中，并已设为当前选择` : `${asset.name || asset.relPath} 已加入画布`;
    await activate(state.active);
    setStatus(message, "ready");
  } catch (error) {
    button.disabled = false;
    setStatus(error.message || "加入画布失败", "error");
  }
}

function assetTile(asset, { compact = false } = {}) {
  const tile = node("article", "asset-tile is-loading");
  tile.dataset.relPath = asset.relPath;
  if (compact) tile.dataset.compact = "true";
  const previewButton = node("button", "asset-preview-button");
  previewButton.type = "button";
  const media = node("span", "asset-media");
  const image = node("img");
  image.alt = asset.name || asset.relPath;
  image.loading = "lazy";
  image.dataset.previewPath = asset.relPath;
  media.append(image, node("span", "asset-skeleton"));
  const copy = node("span", "asset-copy");
  copy.append(node("strong", "", asset.name || asset.relPath.split("/").at(-1)), node("small", "", asset.folder || "项目根目录"));
  previewButton.append(media, copy);
  previewButton.addEventListener("click", () => {
    for (const item of tile.closest(".asset-contact-sheet")?.querySelectorAll(".asset-tile") || []) item.dataset.selected = String(item === tile);
    setStatus(`已选中预览：${asset.name || asset.relPath}`, "info");
  });
  const addButton = node("button", "asset-add-button", state.workspace?.board?.nodes?.some((item) => item.kind === "asset" && item.relPath === asset.relPath) ? "已在画布" : "加入画布");
  addButton.type = "button";
  addButton.addEventListener("click", () => void addAssetToCanvas(asset, addButton));
  tile.append(previewButton, addButton);
  tile.dataset.selected = "false";
  return tile;
}

function createAssetContactSheet(assets, { limit = 18, compact = false } = {}) {
  const sheet = node("div");
  sheet.className = "asset-contact-sheet";
  if (compact) sheet.dataset.compact = "true";
  const visible = (assets || []).slice(0, limit);
  if (!visible.length) return emptyState("还没有可用图片", "把 PNG、JPG、WebP、GIF 或 AVIF 放入项目后刷新。");
  sheet.append(...visible.map((asset) => assetTile(asset, { compact })));
  return sheet;
}

function boardBounds(nodes) {
  if (!nodes.length) return { left: 0, top: 0, width: 1000, height: 640 };
  const left = Math.min(...nodes.map((item) => Number(item.x) || 0));
  const top = Math.min(...nodes.map((item) => Number(item.y) || 0));
  const right = Math.max(...nodes.map((item) => (Number(item.x) || 0) + Math.max(120, Number(item.width) || 240)));
  const bottom = Math.max(...nodes.map((item) => (Number(item.y) || 0) + Math.max(90, Number(item.height) || 180)));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function createCompactCanvas(workspace, { tall = false } = {}) {
  const board = workspace?.board || { nodes: [], selectedIds: [], rev: 0 };
  const nodes = Array.isArray(board.nodes) ? board.nodes.slice(0, 80) : [];
  const canvas = node("div");
  canvas.className = "compact-canvas";
  if (tall) canvas.dataset.tall = "true";
  const world = node("div", "compact-canvas-world");
  const bounds = boardBounds(nodes);
  let hydratedAssetCount = 0;
  for (const item of nodes) {
    const canvasNode = node("button", "canvas-node");
    canvasNode.type = "button";
    canvasNode.dataset.kind = item.kind || "unknown";
    canvasNode.dataset.selected = String((board.selectedIds || []).includes(item.id));
    canvasNode.style.left = `${((Number(item.x) || 0) - bounds.left) / bounds.width * 100}%`;
    canvasNode.style.top = `${((Number(item.y) || 0) - bounds.top) / bounds.height * 100}%`;
    const sourceWidth = Math.max(120, Number(item.width) || 240);
    const sourceHeight = Math.max(90, Number(item.height) || 180);
    canvasNode.style.width = `${Math.max(12, Math.min(62, sourceWidth / bounds.width * 100))}%`;
    canvasNode.style.aspectRatio = `${sourceWidth} / ${sourceHeight}`;
    if (item.kind === "asset") {
      if (hydratedAssetCount < MAX_CANVAS_PREVIEWS) {
        hydratedAssetCount += 1;
        canvasNode.classList.add("is-loading");
        const image = node("img");
        image.alt = item.label || item.relPath || "画布图片";
        image.dataset.previewPath = item.relPath;
        canvasNode.append(image, node("span", "asset-skeleton"));
      } else {
        canvasNode.append(node("span", "canvas-preview-limit", item.label || "图片节点"));
      }
    } else if (item.kind === "note") {
      canvasNode.append(node("span", "note-copy", item.text || "便签"));
      canvasNode.dataset.tone = item.tone || "amber";
    } else {
      canvasNode.append(node("span", "note-copy", item.label || "节点"));
    }
    canvasNode.addEventListener("click", () => {
      for (const sibling of world.querySelectorAll(".canvas-node")) sibling.dataset.selected = String(sibling === canvasNode);
      setStatus(`已定位画布节点 ${item.label || item.relPath || item.id}`, "info");
    });
    world.append(canvasNode);
  }
  if (!nodes.length) world.append(emptyState("画布还是空的", "从资产模式选择图片，再到完整 Visual Workspace 中编排。"));
  canvas.append(world);
  return canvas;
}

async function runToolAction(tool, button) {
  button.disabled = true;
  setStatus(`正在打开 ${tool.label}`, "loading");
  try {
    const result = await api("./api/tools/action", {
      method: "POST",
      body: JSON.stringify({ actionId: tool.id }),
    });
    setStatus(result.action === "composer-prefilled"
      ? `${tool.label} 操作已写入输入框，尚未发送`
      : result.action === "native-control" ? `${tool.label} 已打开` : `${tool.label} 当前不可用`, result.action === "unavailable" ? "warning" : "ready");
  } catch (error) {
    setStatus(error.message || `${tool.label} 打开失败`, "error");
  } finally {
    button.disabled = tool.available !== true;
  }
}

function toolButton(tool, { compact = false } = {}) {
  const button = node("button", "tool-button");
  button.type = "button";
  button.disabled = tool.available !== true;
  if (compact) button.dataset.compact = "true";
  const isVisualWorkspace = tool.id === "visual-workspace";
  const displayLabel = isVisualWorkspace ? "准备打开画布" : tool.label;
  const glyph = node("span", "tool-glyph", displayLabel.trim().slice(0, 1).toUpperCase());
  const copy = node("span", "tool-copy");
  copy.append(node("strong", "", displayLabel), node("small", "", isVisualWorkspace ? "预填请求，不发送" : "Codex 原生入口"));
  button.append(glyph, copy, icon("arrow"));
  button.addEventListener("click", () => void runToolAction(tool, button));
  return button;
}

function modeIntro(title, detail, actions = []) {
  const header = node("header", "mode-intro");
  const copy = node("div");
  copy.append(node("h1", "", title), node("p", "", detail));
  const controls = node("div", "mode-actions");
  controls.append(...actions);
  header.append(copy, controls);
  return header;
}

function renderApprovalRequired(status) {
  const wrapper = node("section", "approval-state");
  const mark = node("div", "approval-mark");
  mark.append(icon("canvas"));
  wrapper.append(
    mark,
    node("h1", "", "需要项目授权"),
    node("p", "", "先在原生 Visual Workspace 中确认这个项目。授权完成后，工作面板会直接复用同一项目和画布。"),
    chip(status.accessState || "confirmation_required", "warning"),
  );
  elements.content.replaceChildren(wrapper);
  setStatus("等待原生 Visual Workspace 授权", "warning");
}

function renderChanges(section, changes) {
  section.replaceChildren(sectionHeading("变更", changes.dirtyCount ? `${changes.dirtyCount} 个文件` : "工作区干净"));
  const changeList = node("div");
  changeList.className = "change-list";
  if (changes.paths?.length) {
    for (const file of changes.paths.slice(0, 6)) {
      const row = node("div", "change-row");
      row.append(node("span", "change-dot"), node("code", "", file));
      changeList.append(row);
    }
  } else {
    changeList.append(node("p", "quiet-copy", `Ahead ${changes.ahead || 0} · Behind ${changes.behind || 0}`));
  }
  section.append(changeList);
}

const registry = new PanelModuleRegistry({ capabilities: ["workspace", "assets", "tasks", "git", "tools"] });

registry.register({
  id: "overview", label: "工作台", order: 10, requiredCapabilities: [],
  async mount({ generation }) {
    const [status, workspace, tasks, changes, tools] = await Promise.all([api("./api/status"), api("./api/workspace"), api("./api/tasks"), api("./api/changes"), api("./api/tools")]);
    if (generation !== state.generation) return;
    state.workspace = workspace;
    const view = node("div", "workbench-view");
    const hero = node("section", "workbench-hero");
    const heroCopy = node("div", "workbench-identity");
    heroCopy.append(node("span", "context-label", "当前任务"), node("h1", "", status.threadTitle || "当前 Codex 任务"), node("p", "path-copy", status.projectDir || ""));
    const heroMeta = node("div", "context-chips");
    heroMeta.append(
      chip(changes.branch || "无分支", "branch"),
      chip(`${workspace.assets?.length || 0} 张图片`, "neutral"),
      chip(`R${workspace.board?.rev ?? 0}`, "neutral"),
      chip(status.accessState === "approved" ? "已授权" : status.accessState, status.accessState === "approved" ? "positive" : "warning"),
    );
    hero.append(heroCopy, heroMeta);

    const toolsSection = node("section", "workbench-section quick-tools-section");
    toolsSection.append(sectionHeading("继续工作", "操作不会自动发送"));
    const toolRow = node("div");
    toolRow.className = "tool-row";
    toolRow.append(...(tools.tools || []).slice(0, 5).map((tool) => toolButton(tool, { compact: true })));
    toolsSection.append(toolRow);

    const assetsSection = node("section", "workbench-section asset-section");
    assetsSection.append(sectionHeading("最近资产", `${workspace.assets?.length || 0} 张`), createAssetContactSheet(workspace.assets, { limit: 5, compact: true }));

    const canvasSection = node("section", "workbench-section canvas-section");
    canvasSection.append(sectionHeading("画布脉搏", `${workspace.board?.nodes?.length || 0} 个节点 · Revision ${workspace.board?.rev ?? 0}`), createCompactCanvas(workspace));

    const lower = node("div");
    lower.className = "workbench-layout";
    const activity = node("div", "activity-column");
    const taskSection = node("section", "context-section");
    taskSection.append(sectionHeading("任务", `${tasks.tasks?.length || 0}`));
    for (const task of tasks.tasks || []) {
      const row = node("div", "task-row");
      row.append(icon("task"), node("strong", "", task.title), chip(task.status || "current", "positive"));
      taskSection.append(row);
    }

    const changeSection = node("section", "context-section");
    renderChanges(changeSection, changes);
    activity.append(taskSection, changeSection);

    lower.append(activity);
    view.append(hero, assetsSection, canvasSection, toolsSection, lower);
    elements.content.replaceChildren(view);
    clearInterval(overviewRefreshTimer);
    overviewRefreshTimer = setInterval(() => {
      void api("./api/changes").then((latest) => {
        if (generation === state.generation && state.active === "overview" && changeSection.isConnected) renderChanges(changeSection, latest);
      }).catch(() => {});
    }, 5_000);
  },
  async destroy() {
    clearInterval(overviewRefreshTimer);
    overviewRefreshTimer = null;
  },
});

registry.register({
  id: "assets", label: "资产", order: 20, requiredCapabilities: [],
  async mount({ generation }) {
    const workspace = await api("./api/workspace");
    if (generation !== state.generation) return;
    state.workspace = workspace;
    const view = node("div", "assets-view");
    const search = node("label", "asset-search");
    search.append(icon("search"));
    const input = node("input");
    input.type = "search";
    input.placeholder = "搜索图片或文件夹";
    input.setAttribute("aria-label", "搜索图片或文件夹");
    search.append(input);
    const sheetHost = node("div", "asset-sheet-host");
    const render = ({ hydrate = true } = {}) => {
      if (hydrate) resetPreviewScheduling();
      const query = input.value.trim().toLocaleLowerCase();
      const filtered = (workspace.assets || []).filter((asset) => !query || `${asset.name} ${asset.folder} ${asset.relPath}`.toLocaleLowerCase().includes(query));
      sheetHost.replaceChildren(createAssetContactSheet(filtered, { limit: 36 }));
      if (hydrate) void hydrateImages(sheetHost, generation);
      setStatus(query ? `找到 ${filtered.length} 张匹配图片` : `已载入 ${filtered.length} 张项目图片`, "ready");
    };
    input.addEventListener("input", () => render());
    view.append(modeIntro("资产接触表", "直接查看已授权项目中的图片，不复制、不移动原文件。", [search]), sheetHost);
    elements.content.replaceChildren(view);
    render({ hydrate: false });
  },
  async destroy() {},
});

registry.register({
  id: "canvas", label: "画布", order: 30, requiredCapabilities: [],
  async mount({ generation }) {
    const workspace = await api("./api/workspace");
    if (generation !== state.generation) return;
    state.workspace = workspace;
    const visualTool = { id: "visual-workspace", label: "完整 Visual Workspace", available: true };
    const openButton = actionButton("填写打开画布请求", () => void runToolAction(visualTool, openButton), { primary: true });
    const view = node("div", "canvas-view");
    const summary = node("div", "canvas-summary");
    summary.append(chip(`Revision ${workspace.board?.rev ?? 0}`, "neutral"), chip(`${workspace.board?.nodes?.length || 0} 个节点`, "neutral"), chip(`${workspace.board?.selectedIds?.length || 0} 个选择`, "neutral"));
    view.append(
      modeIntro("紧凑画布", "查看真实节点比例与当前选择。完整编辑继续使用原生画布，状态保持同一 revision。", [openButton]),
      summary,
      createCompactCanvas(workspace, { tall: true }),
    );
    elements.content.replaceChildren(view);
  },
  async destroy() {},
});

async function activate(id) {
  if (!PRIMARY_MODULES.includes(id)) return;
  if (id !== "overview") {
    clearInterval(overviewRefreshTimer);
    overviewRefreshTimer = null;
  }
  resetPreviewScheduling();
  state.active = id;
  state.generation += 1;
  const generation = state.generation;
  for (const button of elements.tabs.querySelectorAll("button")) {
    const active = button.dataset.module === id;
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  elements.content.setAttribute("aria-busy", "true");
  elements.content.replaceChildren(node("div", "panel-loading", "正在整理工作区…"));
  setStatus(`正在载入${registry.list().find((module) => module.id === id)?.label || "模块"}`, "loading");
  try {
    await registry.mount(id, { generation });
    if (generation === state.generation) {
      await hydrateImages(elements.content, generation);
      setStatus("已连接当前 Codex 工作区", "ready");
    }
  } catch (error) {
    if (generation === state.generation) elements.content.replaceChildren(emptyState("模块暂时无法载入", error.message || error));
    setStatus(error.message || "模块载入失败", "error");
  } finally {
    if (generation === state.generation) elements.content.setAttribute("aria-busy", "false");
  }
}

async function start() {
  const status = await api("./api/status");
  state.status = status;
  elements.title.textContent = status.projectName || "当前工作区";
  elements.context.textContent = status.threadTitle || status.projectDir || "当前 Codex 任务";
  setConnection(status.bridgeState === "ready" ? "已连接" : "需要授权", status.bridgeState === "ready" ? "positive" : "warning");
  if (status.bridgeState !== "ready") {
    elements.app.setAttribute("aria-busy", "false");
    renderApprovalRequired(status);
    return;
  }
  elements.tabs.replaceChildren(...PRIMARY_MODULES.map((id) => {
    const module = registry.list().find((entry) => entry.id === id);
    const button = node("button");
    button.type = "button";
    button.dataset.module = id;
    button.append(icon(id), node("span", "", module.label));
    button.addEventListener("click", () => void activate(id));
    return button;
  }));
  elements.app.setAttribute("aria-busy", "false");
  await activate(state.active);
}

window.addEventListener("pagehide", () => {
  state.disposed = true;
  clearInterval(overviewRefreshTimer);
  overviewRefreshTimer = null;
  resetPreviewScheduling();
  for (const entry of state.previewCache.values()) URL.revokeObjectURL(entry.url);
  state.previewCache.clear();
  state.previewPromises.clear();
  state.previewBytes = 0;
  void registry.destroyAll();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  window.parent.postMessage({ source: "workspace-panel", action: "close" }, "*");
});
void start().catch((error) => {
  elements.app.setAttribute("aria-busy", "false");
  setConnection("连接失败", "error");
  elements.content.replaceChildren(emptyState("工作面板连接失败", error.message || error));
  setStatus("请关闭后重试", "error");
});
