const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const assetKinds = new Set(["image", "frame", "contact"]);

function nodeElement(node, selected) {
  const element = document.createElement("article");
  element.className = `canvas-node canvas-node-${node.kind}${selected ? " selected" : ""}`;
  element.dataset.nodeId = node.id;
  element.tabIndex = 0;
  element.setAttribute("role", "option");
  element.style.transform = `translate(${node.x}px, ${node.y}px)`;
  element.style.width = `${node.width}px`;
  element.style.height = `${node.height}px`;
  element.style.zIndex = String(node.z);
  element.setAttribute("aria-label", node.kind === "asset" ? `画布图片：${node.ref.label}` : "画布便签");

  const bar = document.createElement("header");
  bar.className = "canvas-node-bar";
  const drag = document.createElement("span");
  drag.className = "canvas-node-drag";
  drag.textContent = "⠿";
  drag.setAttribute("aria-hidden", "true");
  const label = document.createElement("strong");
  label.textContent = node.kind === "asset" ? node.ref.label : "便签";
  bar.append(drag, label);
  element.append(bar);

  if (node.kind === "asset") {
    const image = document.createElement("img");
    image.src = node.mediaUrl;
    image.alt = node.ref.label;
    image.loading = "lazy";
    image.decoding = "async";
    element.append(image);
  } else {
    const note = document.createElement("textarea");
    note.className = "canvas-note-editor";
    note.value = node.text;
    note.maxLength = 2000;
    note.setAttribute("aria-label", "便签内容");
    element.dataset.tone = node.tone || "neutral";
    element.append(note);
  }
  return element;
}

function intersects(left, right) {
  return left.left <= right.right && left.right >= right.left && left.top <= right.bottom && left.bottom >= right.top;
}

export function createCanvasController({
  elements,
  request,
  getProjectId,
  getSelectedAssets,
  onOpenAsset,
  onAttachAssets,
  onActiveChange = () => {},
  notify,
  canAttach = false,
}) {
  let board = null;
  let active = false;
  let busy = false;
  let pointer = null;
  let saveTimer = 0;
  let editRevision = 0;
  let loadGeneration = 0;
  const selected = new Set();
  const viewport = elements.viewport;
  const world = elements.world;

  const setBusy = (value) => {
    busy = value;
    elements.workspace.setAttribute("aria-busy", String(value));
    elements.saveState.textContent = value ? "正在同步…" : board?.updatedAt ? "已保存到本机" : "本机草图";
  };

  function updateTransform() {
    if (!board) return;
    world.style.transform = `translate(${board.viewport.x}px, ${board.viewport.y}px) scale(${board.viewport.scale})`;
    elements.zoomValue.textContent = `${Math.round(board.viewport.scale * 100)}%`;
  }

  function updateSelectionUi() {
    for (const element of world.querySelectorAll(".canvas-node")) {
      const isSelected = selected.has(element.dataset.nodeId);
      element.classList.toggle("selected", isSelected);
      element.setAttribute("aria-selected", String(isSelected));
    }
    elements.selectionState.textContent = selected.size ? `已选 ${selected.size} 项` : "拖动画布 · 滚轮平移 · ⌘滚轮缩放";
    elements.deleteSelected.disabled = selected.size === 0;
    elements.attachSelected.disabled = !canAttach || ![...selected].some((id) => board?.nodes.find((node) => node.id === id)?.kind === "asset");
    elements.attachSelected.title = canAttach ? "附加所选图片到当前 Codex 对话" : "仅在 Codex 内嵌工作台中可用";
    const existing = new Set(board?.nodes.filter((node) => node.kind === "asset").map((node) => node.ref.relPath) || []);
    const available = getSelectedAssets().filter((asset) => !asset.isGroup && assetKinds.has(asset.kind) && !existing.has(asset.relPath));
    elements.addSelected.disabled = available.length === 0;
    elements.addSelected.textContent = available.length ? `加入素材选择（${available.length}）` : "先在网格选择图片";
    elements.addSelected.title = available.length ? "把素材网格中选中的图片加入当前项目画布" : "切换到素材网格并选择尚未加入画布的图片";
  }

  function render() {
    world.innerHTML = "";
    if (!board) return;
    for (const node of [...board.nodes].sort((left, right) => left.z - right.z)) {
      world.append(nodeElement(node, selected.has(node.id)));
    }
    elements.empty.hidden = board.nodes.length > 0;
    updateTransform();
    updateSelectionUi();
  }

  async function saveNow({ propagate = false } = {}) {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!board || !active) return;
    if (busy) {
      scheduleSave(300, { edited: false });
      return;
    }
    setBusy(true);
    const savingEditRevision = editRevision;
    try {
      const projectId = board.projectId;
      const data = await request(`/api/canvas?project=${encodeURIComponent(projectId)}`, {
        method: "PUT",
        body: JSON.stringify({
          baseRev: board.rev,
          viewport: board.viewport,
          nodes: board.nodes.map(({ mediaUrl, downloadUrl, ...node }) => node),
        }),
      });
      if (board?.projectId !== projectId) return;
      if (editRevision === savingEditRevision) {
        board = data.board;
      } else {
        board = { ...board, rev: data.board.rev, updatedAt: data.board.updatedAt };
        scheduleSave(0, { edited: false });
      }
    } catch (error) {
      notify(`画布保存失败：${error.message}`, { tone: "error" });
      if (!propagate && board?.projectId === getProjectId()) await load({ force: true }).catch(() => {});
      if (propagate) throw error;
    } finally {
      setBusy(false);
    }
  }

  function scheduleSave(delay = 280, { edited = true } = {}) {
    if (edited) editRevision += 1;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => saveNow(), delay);
  }

  async function flushPendingSave() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!active || !board) return;
    const deadline = Date.now() + 10_000;
    while (busy) {
      if (Date.now() >= deadline) throw new Error("画布仍在同步，项目切换已暂停；请稍后重试");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!active || !board) return;
    await saveNow({ propagate: true });
  }

  async function load({ force = false } = {}) {
    const projectId = getProjectId();
    if (!projectId) return;
    if (!force && board?.projectId === projectId) return;
    const generation = ++loadGeneration;
    setBusy(true);
    try {
      const data = await request(`/api/canvas?project=${encodeURIComponent(projectId)}`);
      if (generation !== loadGeneration || projectId !== getProjectId()) return;
      board = data.board;
      editRevision = 0;
      selected.clear();
      render();
    } finally {
      if (generation === loadGeneration) setBusy(false);
    }
  }

  async function setActive(value) {
    active = value;
    elements.workspace.hidden = !value;
    elements.grid.hidden = value;
    elements.switcher.querySelectorAll("button").forEach((button) => {
      const pressed = button.dataset.assetView === (value ? "canvas" : "grid");
      button.classList.toggle("active", pressed);
      button.setAttribute("aria-pressed", String(pressed));
    });
    document.body.classList.toggle("canvas-active", value);
    onActiveChange(value);
    if (value) await load();
  }

  function viewportCenter() {
    const scale = board.viewport.scale;
    return {
      x: (viewport.clientWidth / 2 - board.viewport.x) / scale,
      y: (viewport.clientHeight / 2 - board.viewport.y) / scale,
    };
  }

  async function addAssets(assets = getSelectedAssets()) {
    if (!board || board.projectId !== getProjectId()) await load({ force: true });
    if (!board) return;
    const eligible = assets.filter((asset) => !asset.isGroup && assetKinds.has(asset.kind));
    if (!eligible.length) {
      notify("空间画布目前接收图片、抽帧和接触表", { tone: "error" });
      return;
    }
    const existing = new Set(board.nodes.filter((node) => node.kind === "asset").map((node) => node.ref.relPath));
    const center = viewportCenter();
    let added = 0;
    for (const asset of eligible.slice(0, 24)) {
      if (existing.has(asset.relPath)) continue;
      const column = added % 4;
      const row = Math.floor(added / 4);
      board.nodes.push({
        id: `asset-${Date.now().toString(36)}-${added}-${Math.random().toString(36).slice(2, 7)}`,
        kind: "asset",
        x: center.x - 560 + column * 360,
        y: center.y - 260 + row * 290,
        width: 320,
        height: 200,
        z: board.nodes.length + added,
        ref: { relPath: asset.relPath, label: asset.name },
        mediaUrl: asset.mediaUrl,
        downloadUrl: asset.downloadUrl,
      });
      existing.add(asset.relPath);
      added += 1;
    }
    if (!added) {
      notify("这些图片已经在画布上");
      return;
    }
    render();
    scheduleSave(0);
    notify(`已加入空间画布：${added} 项`);
  }

  function addNote() {
    if (!board) return;
    const center = viewportCenter();
    const node = {
      id: `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      kind: "note",
      x: center.x - 130,
      y: center.y - 90,
      width: 260,
      height: 180,
      z: board.nodes.length,
      text: "记录画面意图、修改意见或镜头关系…",
      tone: "neutral",
    };
    board.nodes.push(node);
    selected.clear();
    selected.add(node.id);
    render();
    scheduleSave(0);
    world.querySelector(`[data-node-id="${CSS.escape(node.id)}"] textarea`)?.select();
  }

  function setScale(nextScale, clientX = viewport.clientWidth / 2, clientY = viewport.clientHeight / 2) {
    if (!board) return;
    const bounds = viewport.getBoundingClientRect();
    const pointX = clientX - bounds.left;
    const pointY = clientY - bounds.top;
    const beforeX = (pointX - board.viewport.x) / board.viewport.scale;
    const beforeY = (pointY - board.viewport.y) / board.viewport.scale;
    board.viewport.scale = clamp(nextScale, 0.1, 8);
    board.viewport.x = pointX - beforeX * board.viewport.scale;
    board.viewport.y = pointY - beforeY * board.viewport.scale;
    updateTransform();
    scheduleSave();
  }

  function fit() {
    if (!board) return;
    if (!board.nodes.length) {
      board.viewport = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2, scale: 1 };
      updateTransform();
      scheduleSave();
      return;
    }
    const left = Math.min(...board.nodes.map((node) => node.x));
    const top = Math.min(...board.nodes.map((node) => node.y));
    const right = Math.max(...board.nodes.map((node) => node.x + node.width));
    const bottom = Math.max(...board.nodes.map((node) => node.y + node.height));
    const scale = clamp(Math.min((viewport.clientWidth - 96) / (right - left), (viewport.clientHeight - 96) / (bottom - top)), 0.1, 2);
    board.viewport.scale = scale;
    board.viewport.x = (viewport.clientWidth - (right - left) * scale) / 2 - left * scale;
    board.viewport.y = (viewport.clientHeight - (bottom - top) * scale) / 2 - top * scale;
    updateTransform();
    scheduleSave();
  }

  function deleteSelected() {
    if (!board || !selected.size) return;
    board.nodes = board.nodes.filter((node) => !selected.has(node.id));
    selected.clear();
    render();
    scheduleSave(0);
  }

  function selectedAssetRefs() {
    return board?.nodes.filter((node) => selected.has(node.id) && node.kind === "asset") || [];
  }

  viewport.addEventListener("wheel", (event) => {
    if (!active || !board) return;
    event.preventDefault();
    if (event.metaKey || event.ctrlKey) {
      setScale(board.viewport.scale * Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
    } else {
      board.viewport.x -= event.deltaX;
      board.viewport.y -= event.deltaY;
      updateTransform();
      scheduleSave();
    }
  }, { passive: false });

  viewport.addEventListener("pointerdown", (event) => {
    if (!active || !board || event.button !== 0) return;
    const nodeElementTarget = event.target.closest(".canvas-node");
    const node = nodeElementTarget ? board.nodes.find((item) => item.id === nodeElementTarget.dataset.nodeId) : null;
    if (event.target.matches("textarea, input, button, a")) return;
    viewport.setPointerCapture(event.pointerId);
    if (node) {
      if (!selected.has(node.id)) {
        if (!event.shiftKey && !event.metaKey) selected.clear();
        selected.add(node.id);
      } else if ((event.shiftKey || event.metaKey) && selected.size > 1) {
        selected.delete(node.id);
        updateSelectionUi();
        return;
      }
      const origins = new Map(board.nodes.filter((item) => selected.has(item.id)).map((item) => [item.id, { x: item.x, y: item.y }]));
      pointer = { type: "move", id: event.pointerId, startX: event.clientX, startY: event.clientY, origins };
      updateSelectionUi();
      return;
    }
    if (!event.shiftKey) selected.clear();
    if (event.shiftKey) {
      elements.marquee.hidden = false;
      pointer = { type: "marquee", id: event.pointerId, startX: event.clientX, startY: event.clientY };
    } else {
      pointer = {
        type: "pan",
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: board.viewport.x,
        originY: board.viewport.y,
      };
      viewport.classList.add("is-panning");
    }
    updateSelectionUi();
  });

  viewport.addEventListener("pointermove", (event) => {
    if (!pointer || event.pointerId !== pointer.id || !board) return;
    const dx = event.clientX - pointer.startX;
    const dy = event.clientY - pointer.startY;
    if (pointer.type === "pan") {
      board.viewport.x = pointer.originX + dx;
      board.viewport.y = pointer.originY + dy;
      updateTransform();
    } else if (pointer.type === "move") {
      for (const [id, origin] of pointer.origins) {
        const node = board.nodes.find((item) => item.id === id);
        if (!node) continue;
        node.x = origin.x + dx / board.viewport.scale;
        node.y = origin.y + dy / board.viewport.scale;
        const element = world.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
        if (element) element.style.transform = `translate(${node.x}px, ${node.y}px)`;
      }
    } else if (pointer.type === "marquee") {
      const bounds = viewport.getBoundingClientRect();
      const left = Math.min(pointer.startX, event.clientX) - bounds.left;
      const top = Math.min(pointer.startY, event.clientY) - bounds.top;
      elements.marquee.style.cssText = `left:${left}px;top:${top}px;width:${Math.abs(dx)}px;height:${Math.abs(dy)}px`;
    }
  });

  const finishPointer = (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    if (pointer.type === "marquee") {
      const selectionRect = elements.marquee.getBoundingClientRect();
      for (const element of world.querySelectorAll(".canvas-node")) {
        if (intersects(selectionRect, element.getBoundingClientRect())) selected.add(element.dataset.nodeId);
      }
      elements.marquee.hidden = true;
      elements.marquee.removeAttribute("style");
      updateSelectionUi();
    }
    if (pointer.type === "move" || pointer.type === "pan") scheduleSave();
    viewport.classList.remove("is-panning");
    pointer = null;
  };
  viewport.addEventListener("pointerup", finishPointer);
  viewport.addEventListener("pointercancel", finishPointer);

  world.addEventListener("input", (event) => {
    const nodeId = event.target.closest(".canvas-node")?.dataset.nodeId;
    const node = board?.nodes.find((item) => item.id === nodeId);
    if (node?.kind === "note" && event.target.matches("textarea")) {
      node.text = event.target.value;
      scheduleSave();
    }
  });
  world.addEventListener("dblclick", (event) => {
    const nodeId = event.target.closest(".canvas-node-asset")?.dataset.nodeId;
    const node = board?.nodes.find((item) => item.id === nodeId);
    if (node) Promise.resolve(onOpenAsset(node.ref)).catch((error) => notify(error.message, { tone: "error" }));
  });

  elements.switcher.addEventListener("click", (event) => {
    const button = event.target.closest("[data-asset-view]");
    if (button) setActive(button.dataset.assetView === "canvas").catch((error) => notify(error.message, { tone: "error" }));
  });
  elements.addSelected.addEventListener("click", () => addAssets().catch((error) => notify(error.message, { tone: "error" })));
  elements.addNote.addEventListener("click", addNote);
  elements.zoomIn.addEventListener("click", () => setScale((board?.viewport.scale || 1) * 1.2));
  elements.zoomOut.addEventListener("click", () => setScale((board?.viewport.scale || 1) / 1.2));
  elements.fit.addEventListener("click", fit);
  elements.deleteSelected.addEventListener("click", deleteSelected);
  elements.attachSelected.addEventListener("click", () => onAttachAssets(selectedAssetRefs().map((node) => ({
    name: node.ref.label,
    relPath: node.ref.relPath,
    mediaUrl: node.mediaUrl,
  }))));
  viewport.addEventListener("keydown", (event) => {
    if (event.target.matches("textarea, input")) return;
    const focusedNodeId = event.target.closest?.(".canvas-node")?.dataset.nodeId;
    const focusedNode = board?.nodes.find((node) => node.id === focusedNodeId);
    if (focusedNode && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      if (!selected.has(focusedNode.id)) {
        selected.clear();
        selected.add(focusedNode.id);
      }
      const step = (event.shiftKey ? 40 : 8) / board.viewport.scale;
      if (event.key === "ArrowLeft") focusedNode.x -= step;
      if (event.key === "ArrowRight") focusedNode.x += step;
      if (event.key === "ArrowUp") focusedNode.y -= step;
      if (event.key === "ArrowDown") focusedNode.y += step;
      event.target.style.transform = `translate(${focusedNode.x}px, ${focusedNode.y}px)`;
      updateSelectionUi();
      scheduleSave();
    } else if (focusedNode && event.key === " ") {
      event.preventDefault();
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        if (selected.has(focusedNode.id)) selected.delete(focusedNode.id);
        else selected.add(focusedNode.id);
      } else {
        selected.clear();
        selected.add(focusedNode.id);
      }
      updateSelectionUi();
    } else if (focusedNode && event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        if (selected.has(focusedNode.id)) selected.delete(focusedNode.id);
        else selected.add(focusedNode.id);
        updateSelectionUi();
      } else if (focusedNode.kind === "asset") {
        Promise.resolve(onOpenAsset(focusedNode.ref)).catch((error) => notify(error.message, { tone: "error" }));
      } else {
        event.target.querySelector("textarea")?.focus();
      }
    } else if (["Backspace", "Delete"].includes(event.key)) {
      event.preventDefault();
      deleteSelected();
    } else if (event.key === "0") {
      event.preventDefault();
      fit();
    }
  });

  return {
    addAssets,
    flushPendingSave,
    load,
    setActive,
    isActive: () => active,
    refreshProject: async () => {
      await flushPendingSave();
      clearTimeout(saveTimer);
      saveTimer = 0;
      board = null;
      selected.clear();
      if (active) await load({ force: true });
    },
  };
}
