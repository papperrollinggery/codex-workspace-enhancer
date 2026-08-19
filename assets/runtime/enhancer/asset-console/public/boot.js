(() => {
  const isDirectFile = window.location.protocol === "file:";

  function appendText(parent, tagName, text, className = "") {
    const element = document.createElement(tagName);
    element.textContent = text;
    if (className) element.className = className;
    parent.append(element);
    return element;
  }

  function renderDirectFileEntry() {
    document.title = "资产控制台 · 启动说明";

    const main = document.createElement("main");
    main.className = "direct-file-launch";
    main.setAttribute("aria-labelledby", "directFileTitle");

    const card = document.createElement("section");
    card.className = "direct-file-card";

    const mark = appendText(card, "div", "A", "direct-file-mark");
    mark.setAttribute("aria-hidden", "true");

    const copy = document.createElement("div");
    copy.className = "direct-file-copy";
    appendText(copy, "p", "ASSET CONSOLE · 本地运行入口", "direct-file-eyebrow");
    const title = appendText(copy, "h1", "这里是源码文件，不是可运行页面");
    title.id = "directFileTitle";
    appendText(
      copy,
      "p",
      "资产控制台依赖本地服务、私有会话令牌和当前 Codex 任务上下文。直接用 file:// 打开会绕过这些运行条件。",
      "direct-file-description",
    );

    const steps = document.createElement("ol");
    steps.className = "direct-file-steps";
    for (const text of [
      "退出当前未由 Enhancer 启动的 ChatGPT / Codex。",
      "从“~/Applications/Codex Sidebar Enhancer.app”重新打开。",
      "在 Codex 侧栏选择“资产控制台”，它会在当前任务内加载。",
    ]) appendText(steps, "li", text);
    copy.append(steps);

    const actions = document.createElement("div");
    actions.className = "direct-file-actions";
    const localService = appendText(actions, "a", "检查本地服务", "direct-file-primary");
    localService.href = "http://127.0.0.1:5177/";
    const sourceNote = appendText(actions, "span", "当前文件仅用于开发与安装打包", "direct-file-note");
    sourceNote.setAttribute("role", "note");
    copy.append(actions);

    card.append(copy);
    main.append(card);
    document.body.replaceChildren(main);
  }

  async function startApplication() {
    try {
      await import("./app.js");
    } catch (error) {
      console.error("Asset Console failed to start", error);
      document.documentElement.classList.add("asset-console-boot-error");
      document.body.setAttribute("aria-busy", "false");
    }
  }

  if (isDirectFile) document.documentElement.classList.add("direct-file-mode");
  const start = isDirectFile ? renderDirectFileEntry : startApplication;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
