import { PanelModuleRegistry } from "./module-registry.mjs";

const elements = {
  app: document.querySelector("#panelApp"),
  title: document.querySelector("#panelTitle"),
  connection: document.querySelector("#connectionState"),
  tabs: document.querySelector("#panelTabs"),
  content: document.querySelector("#panelContent"),
  status: document.querySelector("#panelStatus"),
};

const state = { active: "overview", generation: 0, status: null };

async function api(route, options = {}) {
  const response = await fetch(route, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `工作台请求失败 (${response.status})`);
  return payload;
}

function text(value) {
  const node = document.createElement("span");
  node.textContent = String(value ?? "");
  return node;
}

function card(label, value, detail = "") {
  const item = document.createElement("article");
  item.className = "status-card";
  const name = document.createElement("span");
  name.className = "status-label";
  name.textContent = label;
  const content = document.createElement("strong");
  content.textContent = String(value ?? "—");
  item.append(name, content);
  if (detail) {
    const description = document.createElement("small");
    description.textContent = detail;
    item.append(description);
  }
  return item;
}

function toolCard(tool) {
  const item = card(tool.label, tool.available ? "可用" : "不可用", tool.action || "");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tool-action";
  button.disabled = tool.available !== true;
  button.textContent = "在 Codex 中打开";
  button.addEventListener("click", async () => {
    button.disabled = true;
    elements.status.textContent = `正在打开${tool.label}`;
    try {
      const result = await api("./api/tools/action", {
        method: "POST",
        body: JSON.stringify({ actionId: tool.id }),
      });
      elements.status.textContent = result.action === "composer-prefilled"
        ? `已把${tool.label}操作写入输入框，尚未发送`
        : result.action === "native-control" ? `已打开${tool.label}` : `${tool.label}当前不可用`;
    } catch (error) {
      elements.status.textContent = error.message || `${tool.label}打开失败`;
    } finally {
      button.disabled = tool.available !== true;
    }
  });
  item.append(button);
  return item;
}

function section(title) {
  const fragment = document.createDocumentFragment();
  const heading = document.createElement("h2");
  heading.textContent = title;
  const grid = document.createElement("div");
  grid.className = "status-grid";
  fragment.append(heading, grid);
  return { fragment, grid };
}

function statusModule({ id, label, order, route, render }) {
  return {
    id, label, order,
    requiredCapabilities: [],
    async mount({ generation }) {
      const view = section(label);
      elements.content.replaceChildren(view.fragment);
      const payload = await api(route);
      if (generation !== state.generation) return;
      render(view.grid, payload);
    },
    async destroy() {},
  };
}

const registry = new PanelModuleRegistry({ capabilities: ["workspace", "assets", "tasks", "git", "tools"] });
registry.register(statusModule({
  id: "overview", label: "总览", order: 10, route: "./api/status",
  render(grid, payload) {
    grid.append(
      card("项目", payload.projectName, payload.projectDir),
      card("任务", payload.threadTitle, payload.threadId),
      card("授权", payload.accessState, payload.authorizationSource),
      card("运行", payload.bridgeState, payload.version),
    );
  },
}));
registry.register(statusModule({
  id: "assets", label: "资产", order: 20, route: "./api/workspace",
  render(grid, payload) {
    grid.append(card("可用图片", payload.assets?.length || 0), card("扫描状态", payload.truncated ? "部分" : "完整"));
    for (const asset of (payload.assets || []).slice(0, 12)) grid.append(card(asset.name, asset.folder || "项目根目录"));
  },
}));
registry.register(statusModule({
  id: "canvas", label: "画布", order: 30, route: "./api/workspace",
  render(grid, payload) {
    grid.append(card("Revision", payload.board?.rev ?? 0), card("节点", payload.board?.nodes?.length || 0), card("选择", payload.board?.selectedIds?.length || 0));
  },
}));
registry.register(statusModule({
  id: "tasks", label: "任务", order: 40, route: "./api/tasks",
  render(grid, payload) {
    for (const task of payload.tasks || []) grid.append(card(task.title, task.status, task.threadId));
    if (!payload.tasks?.length) grid.append(card("当前任务", "暂无额外后台任务"));
  },
}));
registry.register(statusModule({
  id: "changes", label: "变更", order: 50, route: "./api/changes",
  render(grid, payload) {
    grid.append(card("分支", payload.branch), card("改动文件", payload.dirtyCount || 0), card("Ahead / Behind", `${payload.ahead || 0} / ${payload.behind || 0}`));
  },
}));
registry.register(statusModule({
  id: "tools", label: "工具", order: 60, route: "./api/tools",
  render(grid, payload) {
    for (const tool of payload.tools || []) grid.append(toolCard(tool));
  },
}));

async function activate(id) {
  state.active = id;
  state.generation += 1;
  const generation = state.generation;
  for (const button of elements.tabs.querySelectorAll("button")) button.setAttribute("aria-selected", String(button.dataset.module === id));
  elements.content.setAttribute("aria-busy", "true");
  elements.status.textContent = `正在载入${registry.list().find((module) => module.id === id)?.label || "模块"}`;
  try {
    await registry.mount(id, { generation });
    if (generation === state.generation) elements.status.textContent = "已连接当前 Codex 工作区";
  } catch (error) {
    if (generation === state.generation) elements.content.replaceChildren(text(error.message || error));
    elements.status.textContent = "模块载入失败";
  } finally {
    elements.content.setAttribute("aria-busy", "false");
  }
}

async function start() {
  const status = await api("./api/status");
  state.status = status;
  elements.title.textContent = status.projectName || "当前工作区";
  elements.connection.textContent = status.bridgeState === "ready" ? "已连接" : "受限";
  elements.tabs.replaceChildren(...registry.list().map((module) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.module = module.id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", "false");
    button.textContent = module.label;
    button.addEventListener("click", () => void activate(module.id));
    return button;
  }));
  elements.app.setAttribute("aria-busy", "false");
  await activate(state.active);
}

window.addEventListener("pagehide", () => void registry.destroyAll());
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  window.parent.postMessage({ source: "workspace-panel", action: "close" }, "*");
});
void start().catch((error) => {
  elements.app.setAttribute("aria-busy", "false");
  elements.connection.textContent = "连接失败";
  elements.content.replaceChildren(text(error.message || error));
  elements.status.textContent = "请关闭后重试";
});
