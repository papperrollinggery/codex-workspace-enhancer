import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_NODES = 300;
const MAX_NOTE_LENGTH = 2_000;
const MAX_LABEL_LENGTH = 300;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function finiteNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function normalizeRelativePath(value) {
  const raw = String(value || "").trim();
  if (!raw || path.isAbsolute(raw)) throw new Error("Canvas asset path must be project-relative");
  const normalized = path.normalize(raw);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("Canvas asset path escapes the project");
  }
  if (!IMAGE_EXTENSIONS.has(path.extname(normalized).toLowerCase())) {
    throw new Error("Canvas currently accepts image assets only");
  }
  return normalized;
}

function normalizeViewport(value = {}) {
  return {
    x: finiteNumber(value.x, 0, -1_000_000, 1_000_000),
    y: finiteNumber(value.y, 0, -1_000_000, 1_000_000),
    scale: finiteNumber(value.scale, 1, 0.1, 8),
  };
}

function normalizeNode(node, index) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new Error(`Canvas node ${index + 1} must be an object`);
  }
  const id = String(node.id || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/u.test(id)) {
    throw new Error(`Canvas node ${index + 1} has an invalid id`);
  }
  const kind = node.kind === "note" ? "note" : node.kind === "asset" ? "asset" : "";
  if (!kind) throw new Error(`Canvas node ${index + 1} has an unsupported kind`);
  const normalized = {
    id,
    kind,
    x: finiteNumber(node.x, 0, -1_000_000, 1_000_000),
    y: finiteNumber(node.y, 0, -1_000_000, 1_000_000),
    width: finiteNumber(node.width, kind === "note" ? 260 : 320, 120, 1_200),
    height: finiteNumber(node.height, kind === "note" ? 180 : 240, 90, 900),
    z: Math.round(finiteNumber(node.z, index, 0, 100_000)),
  };
  if (kind === "asset") {
    normalized.ref = {
      relPath: normalizeRelativePath(node.ref?.relPath),
      label: String(node.ref?.label || path.basename(String(node.ref?.relPath || ""))).slice(0, MAX_LABEL_LENGTH),
    };
  } else {
    normalized.text = String(node.text || "").slice(0, MAX_NOTE_LENGTH);
    normalized.tone = ["neutral", "blue", "amber", "green", "rose"].includes(node.tone) ? node.tone : "neutral";
  }
  return normalized;
}

function normalizeBoard(board, projectId) {
  if (!board || typeof board !== "object" || Array.isArray(board)) throw new Error("Canvas board must be an object");
  const nodes = Array.isArray(board.nodes) ? board.nodes : [];
  if (nodes.length > MAX_NODES) throw new Error(`Canvas supports at most ${MAX_NODES} nodes per project`);
  const normalizedNodes = nodes.map(normalizeNode);
  if (new Set(normalizedNodes.map((node) => node.id)).size !== normalizedNodes.length) {
    throw new Error("Canvas node ids must be unique");
  }
  return {
    version: 1,
    projectId,
    rev: Number.isSafeInteger(board.rev) && board.rev >= 0 ? board.rev : 0,
    viewport: normalizeViewport(board.viewport),
    nodes: normalizedNodes,
    updatedAt: typeof board.updatedAt === "string" ? board.updatedAt : null,
  };
}

export class CanvasStore {
  constructor({ root, validateAsset }) {
    this.root = path.resolve(root);
    this.validateAsset = validateAsset;
    this.queues = new Map();
  }

  boardPath(projectId) {
    const digest = createHash("sha256").update(String(projectId)).digest("hex").slice(0, 32);
    return path.join(this.root, `${digest}.json`);
  }

  async ensureRoot() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const stats = await fs.lstat(this.root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Canvas state root must be a regular directory");
  }

  async read(projectId) {
    await this.ensureRoot();
    const filePath = this.boardPath(projectId);
    let source;
    try {
      const stats = await fs.lstat(filePath);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Canvas board must be a regular file");
      source = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return normalizeBoard({}, projectId);
      throw error;
    }
    try {
      return normalizeBoard(JSON.parse(source.replace(/^\uFEFF/, "")), projectId);
    } catch (error) {
      throw new Error(`Canvas board is invalid and was left untouched: ${filePath}: ${error.message || error}`);
    }
  }

  async write(projectId, body) {
    const previous = this.queues.get(projectId) || Promise.resolve();
    const operation = previous.then(() => this.writeExclusive(projectId, body));
    const queued = operation.catch(() => {});
    this.queues.set(projectId, queued);
    try {
      return await operation;
    } finally {
      if (this.queues.get(projectId) === queued) this.queues.delete(projectId);
    }
  }

  async writeExclusive(projectId, body) {
    const current = await this.read(projectId);
    const baseRev = Number(body?.baseRev);
    if (!Number.isSafeInteger(baseRev) || baseRev !== current.rev) {
      const error = new Error(`Canvas changed elsewhere (expected revision ${current.rev})`);
      error.statusCode = 409;
      error.current = current;
      throw error;
    }
    const next = normalizeBoard({ ...body, rev: current.rev + 1, updatedAt: new Date().toISOString() }, projectId);
    for (const node of next.nodes) {
      if (node.kind === "asset") await this.validateAsset(projectId, node.ref.relPath);
    }
    const filePath = this.boardPath(projectId);
    const temporary = path.join(this.root, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      if (await fs.access(filePath).then(() => true, () => false)) {
        const stats = await fs.lstat(filePath);
        if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Canvas board must be a regular file");
      }
      await fs.rename(temporary, filePath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    return next;
  }
}

export const canvasLimits = Object.freeze({ maxNodes: MAX_NODES, maxNoteLength: MAX_NOTE_LENGTH });
