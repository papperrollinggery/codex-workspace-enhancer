import { createServer } from "node:http";
import { createReadStream, promises as fs, readFileSync, watch } from "node:fs";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DownloadAutomation, normalizeAutomation } from "./download-automation.js";
import { GenerationPipeline } from "./generation-pipeline.js";
import { ExactDuplicateCleaner, normalizeDeduplication } from "./duplicate-cleaner.js";
import { PromptLibrary } from "./prompt-library.js";
import { ThreeDWorkbench } from "./three-d-workbench.js";
import { createProjectFolder, renameProjectFolder } from "./folder-operations.js";
import { CanvasStore } from "./canvas-store.js";
import { protectedCreativePathReason } from "./creative-workflow-safety.js";
import {
  assertRealPathContained,
  isPathInside,
  pathKey,
  pathsEqual,
  resolveAssetBrowserRoot,
  runPythonCommand
} from "./platform-compat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(process.env.ASSET_BROWSER_PUBLIC_ROOT || path.join(__dirname, "public"));
const assetBrowserRoot = resolveAssetBrowserRoot();
const configPath = path.resolve(process.env.ASSET_BROWSER_CONFIG || path.join(assetBrowserRoot, "asset-browser.config.json"));
const ledgerPath = path.resolve(process.env.ASSET_BROWSER_LEDGER || path.join(assetBrowserRoot, ".asset-download-ledger.json"));
const generationRegistryPath = path.resolve(process.env.GENERATION_TICKETS || path.join(assetBrowserRoot, ".generation-tickets.json"));
const generationBindingsPath = path.resolve(process.env.GENERATION_THREAD_BINDINGS || path.join(assetBrowserRoot, ".thread-project-bindings.json"));
const duplicateLedgerPath = path.resolve(process.env.DUPLICATE_CLEANUP_LEDGER || path.join(assetBrowserRoot, ".duplicate-cleanup-ledger.json"));
const duplicateQuarantinePath = path.resolve(process.env.DUPLICATE_QUARANTINE || path.join(assetBrowserRoot, "duplicate-quarantine"));
const rhythmControlRegistryPath = path.resolve(process.env.RHYTHM_CONTROL_REGISTRY || path.join(assetBrowserRoot, ".rhythm-control-tracks.json"));
const promptLibraryRoot = path.resolve(process.env.PROMPT_LIBRARY_ROOT || path.join(assetBrowserRoot, "prompt-library"));
const threeDRegistryPath = path.resolve(process.env.THREE_D_TASKS || path.join(assetBrowserRoot, ".three-d-reconstruction-tasks.json"));
const actionTrashRoot = path.resolve(process.env.ASSET_ACTION_TRASH || path.join(assetBrowserRoot, "action-trash"));
const canvasStateRoot = path.resolve(process.env.ASSET_CANVAS_ROOT || path.join(assetBrowserRoot, "canvas"));
const img2threejsSkillRoot = path.resolve(process.env.IMG2THREEJS_SKILL_ROOT || path.join(os.homedir(), ".codex", "skills", "img2threejs"));
const rhythmControlScriptPath = path.join(__dirname, "rhythm-control-track.py");
const audioSkillRoot = path.resolve(process.env.SCORE_MIX_SKILL_ROOT || path.join(os.homedir(), ".codex", "skills", "score-and-mix-picture"));
const aceStepLauncher = process.env.ACESTEP_LAUNCHER ? path.resolve(process.env.ACESTEP_LAUNCHER) : "";
const port = Number(process.env.PORT || 5177);
const apiTokenPath = path.resolve(process.env.ASSET_BROWSER_TOKEN_FILE || path.join(assetBrowserRoot, ".api-token"));
const apiToken = String(process.env.ASSET_BROWSER_API_TOKEN || readFileSync(apiTokenPath, "utf8")).trim();
if (apiToken.length < 32) throw new Error(`AssetBrowser API token is missing or invalid: ${apiTokenPath}`);
const browserSessionToken = randomBytes(32).toString("hex");
const browserSessionCookie = `asset_console_session=${browserSessionToken}; Path=/; HttpOnly; SameSite=Strict`;

const imageExts = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const videoExts = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const audioExts = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus"]);
const sseClients = new Set();
let watchTimer = null;
const watcherHandles = new Map();
const downloadAutomation = new DownloadAutomation({ ledgerPath });
const generationPipeline = new GenerationPipeline({
  registryPath: generationRegistryPath,
  bindingsPath: generationBindingsPath
});
const duplicateCleaner = new ExactDuplicateCleaner({ ledgerPath: duplicateLedgerPath });
const promptLibrary = new PromptLibrary({ root: promptLibraryRoot });
const threeDWorkbench = new ThreeDWorkbench({ registryPath: threeDRegistryPath, skillRoot: img2threejsSkillRoot });
const canvasStore = new CanvasStore({
  root: canvasStateRoot,
  validateAsset: async (projectId, relPath) => {
    const project = await getProjectStrict(projectId);
    const filePath = safeResolveProject(project, relPath);
    await assertRealPathContained(project.path, filePath);
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Canvas reference must be a regular image file");
  }
});
let automationBusy = false;
let configUpdateQueue = Promise.resolve();
let rhythmRegistryQueue = Promise.resolve();

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendText(res, text, status = 200) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function hasValidApiToken(req) {
  const supplied = String(req.headers["x-asset-console-token"] || "");
  const expected = Buffer.from(apiToken);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hasValidBrowserSession(req) {
  const cookies = String(req.headers.cookie || "").split(";").map((item) => item.trim());
  const supplied = cookies.find((item) => item.startsWith("asset_console_session="))?.slice("asset_console_session=".length) || "";
  const expected = Buffer.from(browserSessionToken);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isAllowedLocalOrigin(req) {
  const origin = String(req.headers.origin || "");
  return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function isProtectedLocalRoute(pathname) {
  return pathname.startsWith("/api/") || pathname === "/media" || pathname === "/download";
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".aac") return "audio/aac";
  if (ext === ".flac") return "audio/flac";
  if (ext === ".ogg" || ext === ".oga") return "audio/ogg";
  if (ext === ".opus") return "audio/opus";
  if (ext === ".md") return "text/markdown; charset=utf-8";
  if (ext === ".txt") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function safeResolve(root, requestedPath) {
  const decoded = decodeURIComponent(requestedPath || "");
  const absolute = path.resolve(root, decoded);
  if (!isPathInside(root, absolute)) {
    throw new Error("Path escapes project root");
  }
  return absolute;
}

function safeResolvePublic(requestedPath) {
  const withoutLeadingSlash = String(requestedPath || "").replace(/^\/+/, "");
  return safeResolve(publicRoot, withoutLeadingSlash || "index.html");
}

function defaultConfig() {
  return {
    enabled: true,
    projects: [],
    automation: normalizeAutomation(),
    deduplication: normalizeDeduplication({}, { defaultQuarantinePath: duplicateQuarantinePath })
  };
}

function safeProjectRoot(rawPath) {
  const value = String(rawPath || "").trim();
  if (!value || !path.isAbsolute(value)) throw new Error("Project path must be absolute");
  const absolute = path.resolve(value);
  const filesystemRoot = path.parse(absolute).root;
  if (pathsEqual(absolute, filesystemRoot) || pathsEqual(absolute, os.homedir())) {
    throw new Error("Project path cannot be a filesystem root or the user home directory");
  }
  const exactDenied = process.platform === "win32"
    ? [process.env.SystemDrive ? `${process.env.SystemDrive}${path.sep}` : "", process.env.USERPROFILE || ""]
    : ["/Users", "/Volumes", "/private"];
  const treeDenied = process.platform === "win32"
    ? [process.env.SystemRoot || "", process.env.ProgramFiles || "", process.env["ProgramFiles(x86)"] || ""]
    : ["/System", "/Library", "/Applications", "/usr", "/bin", "/sbin"];
  if (exactDenied.filter(Boolean).some((candidate) => pathsEqual(absolute, candidate))
    || treeDenied.filter(Boolean).some((candidate) => isPathInside(candidate, absolute))) {
    throw new Error(`Project path is a protected system location: ${absolute}`);
  }
  return absolute;
}

function safeScanRoots(scanRoots) {
  const values = Array.isArray(scanRoots) && scanRoots.length ? scanRoots : ["."];
  return values.map((entry) => {
    const raw = String(entry || ".").trim() || ".";
    if (path.isAbsolute(raw)) throw new Error(`Project scan root must be relative: ${raw}`);
    const normalized = path.normalize(raw);
    if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
      throw new Error(`Project scan root escapes the project: ${raw}`);
    }
    return normalized;
  });
}

function normalizeConfigDocument(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("AssetBrowser config root must be a JSON object");
  }
  if (config.projects !== undefined && !Array.isArray(config.projects)) {
    throw new Error("AssetBrowser config projects must be an array");
  }
  const projects = (config.projects || []).map((project, index) => {
    if (!project || typeof project !== "object" || Array.isArray(project)) {
      throw new Error(`AssetBrowser config project ${index + 1} must be an object`);
    }
    const id = String(project.id || "").trim();
    const rawPath = String(project.path || "").trim();
    if (!id || !rawPath || !path.isAbsolute(rawPath)) {
      throw new Error(`AssetBrowser config project ${index + 1} requires an id and absolute path`);
    }
    return {
      id,
      name: String(project.name || id),
      path: safeProjectRoot(rawPath),
      scanRoots: safeScanRoots(project.scanRoots)
    };
  });
  return {
    enabled: config.enabled !== false,
    projects,
    automation: normalizeAutomation(config.automation),
    deduplication: normalizeDeduplication(config.deduplication, { defaultQuarantinePath: duplicateQuarantinePath })
  };
}

async function loadConfig() {
  let source;
  try {
    source = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return defaultConfig();
    throw error;
  }
  try {
    return normalizeConfigDocument(JSON.parse(source.replace(/^\uFEFF/, "")));
  } catch (error) {
    const wrapped = new Error(`AssetBrowser config is invalid and was left untouched: ${configPath}: ${error.message || error}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

async function saveConfig(config) {
  const normalized = normalizeConfigDocument(config);
  const tempPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  const backupPath = `${configPath}.bak`;
  const backupTempPath = `${backupPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(normalized, null, 2) + "\n", "utf8");
    if (await exists(configPath)) {
      const stats = await fs.lstat(configPath);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("AssetBrowser config must be a regular file");
      if (await exists(backupPath)) {
        const backupStats = await fs.lstat(backupPath);
        if (!backupStats.isFile() || backupStats.isSymbolicLink()) throw new Error("AssetBrowser config backup must be a regular file");
        await fs.rm(backupPath, { force: true });
      }
      await fs.copyFile(configPath, backupTempPath);
      await fs.rename(backupTempPath, backupPath);
    }
    await fs.rename(tempPath, configPath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    await fs.rm(backupTempPath, { force: true }).catch(() => {});
  }
  return normalized;
}

function updateConfig(mutator) {
  const operation = configUpdateQueue.then(async () => {
    const config = await loadConfig();
    const result = await mutator(config);
    const saved = await saveConfig(config);
    return { saved, result };
  });
  configUpdateQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function slugify(input) {
  const base = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return base || `project-${Date.now()}`;
}

async function getProjectStrict(projectId) {
  const config = await loadConfig();
  const project = config.projects.find((item) => item.id === projectId);
  if (!project) throw new Error(`项目不存在：${projectId || "未指定"}`);
  return project;
}

function safeResolveProject(project, requestedPath) {
  return safeResolve(project.path, requestedPath);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filePath);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

function cleanFileStem(value, fallback = "asset") {
  const stem = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "");
  return stem || fallback;
}

async function uniqueAssetPath(desiredPath) {
  const dir = path.dirname(desiredPath);
  const ext = path.extname(desiredPath);
  const stem = path.basename(desiredPath, ext);
  for (let index = 1; index < 10000; index += 1) {
    const suffix = index === 1 ? "" : `-${String(index).padStart(2, "0")}`;
    const candidate = path.join(dir, `${stem}${suffix}${ext}`);
    const candidateStem = candidate.slice(0, -ext.length);
    if (!await exists(candidate) && !await exists(`${candidateStem}.prompt.md`) && !await exists(`${candidateStem}.meta.json`)) {
      return candidate;
    }
  }
  throw new Error("目标文件夹中同名素材过多，无法生成安全文件名");
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function directoryHasMedia(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.some((entry) => {
      if (!entry.isFile()) return false;
      const ext = path.extname(entry.name).toLowerCase();
      return imageExts.has(ext) || videoExts.has(ext) || audioExts.has(ext);
    });
  } catch {
    return false;
  }
}

async function countMediaFiles(dir) {
  try {
    const files = await walk(dir);
    return files.filter((filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      return imageExts.has(ext) || videoExts.has(ext) || audioExts.has(ext);
    }).length;
  } catch {
    return 0;
  }
}

async function readMeta(caseDir) {
  const metaPath = path.join(caseDir, ".asset-review-meta.json");
  try {
    return JSON.parse((await fs.readFile(metaPath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`素材评审元数据损坏，已停止写入：${metaPath}: ${error.message || error}`);
  }
}

async function writeMeta(caseDir, meta) {
  const metaPath = path.join(caseDir, ".asset-review-meta.json");
  const temporary = path.join(caseDir, `.${path.basename(metaPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(meta, null, 2) + "\n", "utf8");
    await fs.rename(temporary, metaPath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function assertCaseMutationContained(project, caseDir, assetPath = "", { allowMissingAsset = false } = {}) {
  await assertRealPathContained(project.path, caseDir);
  await assertRealPathContained(project.path, path.join(caseDir, ".asset-review-meta.json"), { allowMissing: true });
  if (assetPath) await assertRealPathContained(project.path, assetPath, { allowMissing: allowMissingAsset });
}

function assertCreativeSourceMutationAllowed(project, sourcePath) {
  const reason = protectedCreativePathReason(sourcePath, { projectRoot: project.path, project });
  if (reason) throw new Error(`受保护的创意资产不能移动或删除：${reason}`);
}

function assetKind(filePath, caseDir) {
  const ext = path.extname(filePath).toLowerCase();
  const rel = path.relative(caseDir, filePath);
  const parts = rel.split(path.sep);
  const base = path.basename(filePath).toLowerCase();
  if (videoExts.has(ext)) return "video";
  if (audioExts.has(ext)) return "audio";
  if (imageExts.has(ext) && base.includes("contact_sheet")) return "contact";
  if (imageExts.has(ext) && (parts.includes("frames") || /^frame[_-]/.test(base))) return "frame";
  if (imageExts.has(ext)) return "image";
  return "other";
}

function inferVersion(relPath) {
  const match = relPath.match(/(?:^|[_-])v(\d+)(?:[_\-.]|$)/i);
  if (match) return `v${match[1]}`;
  if (relPath.includes("两段式")) return "v4";
  if (relPath.includes("机制母版")) return "v5";
  if (relPath.includes("无首尾帧")) return "v3";
  if (relPath.includes("全能参考_v2")) return "v2";
  return "";
}

function initialStatus(relPath) {
  if (relPath.includes("机制母版_v5_test")) return "可用";
  if (relPath.includes("两段式_v4")) return "可用但需优化";
  if (relPath.includes("无首尾帧_v3")) return "可用但需优化";
  if (relPath.includes("v2") || relPath.includes("雨夜古风追逐")) return "不通过但有参考价值";
  return "未评估";
}

async function listProjects() {
  const config = await loadConfig();
  const projects = [];
  for (const project of config.projects) {
    projects.push({
      id: project.id,
      name: project.name,
      path: project.path,
      scanRoots: project.scanRoots,
      exists: await exists(project.path)
    });
  }
  return projects;
}

async function listProjectFolders(projectId) {
  const project = await getProjectStrict(projectId);
  const folders = [{ path: "", name: "项目根目录", depth: 0 }];
  const limit = 1500;
  const maxDepth = 8;

  async function collect(directory, relativePath = "", depth = 0) {
    if (depth >= maxDepth || folders.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
    for (const entry of directories) {
      if (folders.length >= limit) return;
      const childRelative = relativePath ? path.join(relativePath, entry.name) : entry.name;
      folders.push({ path: childRelative, name: entry.name, depth: depth + 1 });
      await collect(path.join(directory, entry.name), childRelative, depth + 1);
    }
  }

  await collect(project.path);
  return { project: { id: project.id, name: project.name, path: project.path }, folders, truncated: folders.length >= limit };
}

async function addProjectFolder({ projectId, parentPath = "", name }) {
  const project = await getProjectStrict(projectId);
  const folder = await createProjectFolder({ projectPath: project.path, parentPath, name });
  let scanRootAdded = false;

  if (!folder.parentRelativePath) {
    try {
      const update = await updateConfig((config) => {
        const configuredProject = config.projects.find((item) => item.id === project.id);
        if (!configuredProject) throw new Error(`项目不存在：${project.id}`);
        const normalizeRoot = (value) => pathKey(String(value || "").replace(/[\\/]+/g, path.sep).replace(/[\\/]+$/, ""));
        const roots = configuredProject.scanRoots || [];
        const scansWholeProject = roots.some((root) => ["", "."].includes(String(root || "").trim()));
        const targetRoot = normalizeRoot(folder.relativePath);
        if (scansWholeProject || roots.some((root) => normalizeRoot(root) === targetRoot)) return false;
        configuredProject.scanRoots = [...roots, folder.relativePath];
        return true;
      });
      scanRootAdded = update.result;
    } catch (error) {
      try {
        await fs.rmdir(folder.absolutePath);
      } catch (rollbackError) {
        throw new Error(`${error.message || error}；新文件夹回滚失败：${rollbackError.message || rollbackError}`);
      }
      throw error;
    }
  }

  if (scanRootAdded) await ensureWatchers().catch(() => {});
  notifyClients("project-change");
  return {
    path: folder.relativePath,
    name: folder.name,
    parentPath: folder.parentRelativePath,
    scanRootAdded,
  };
}

function normalizeRelativeDirectory(value) {
  const parts = String(value || "")
    .replace(/[\\/]+/g, path.sep)
    .split(path.sep)
    .filter((part) => part && part !== ".");
  return parts.join(path.sep);
}

function replaceRelativeDirectoryPrefix(value, previousPath, nextPath) {
  const candidate = normalizeRelativeDirectory(value);
  const previous = normalizeRelativeDirectory(previousPath);
  const next = normalizeRelativeDirectory(nextPath);
  if (!candidate || !previous) return candidate;
  const candidateParts = candidate.split(path.sep);
  const previousParts = previous.split(path.sep);
  const matches = previousParts.every((part, index) => pathKey(candidateParts[index] || "") === pathKey(part));
  if (!matches) return candidate;
  return [...next.split(path.sep).filter(Boolean), ...candidateParts.slice(previousParts.length)].join(path.sep);
}

function relativeDirectoryFromBase(fullPath, basePath) {
  const full = normalizeRelativeDirectory(fullPath);
  const base = normalizeRelativeDirectory(basePath);
  if (!base) return full;
  if (pathKey(full) === pathKey(base)) return "";
  const relative = path.relative(path.resolve(base), path.resolve(full));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative : null;
}

function rewriteAutomationDirectory(holder, previousPath, nextPath) {
  if (!holder || typeof holder !== "object") return false;
  const previousBasePath = normalizeRelativeDirectory(holder.basePath);
  const nextBasePath = replaceRelativeDirectoryPrefix(previousBasePath, previousPath, nextPath);
  let changed = nextBasePath !== previousBasePath;
  if (holder.routes && typeof holder.routes === "object") {
    for (const [kind, route] of Object.entries(holder.routes)) {
      const routePath = normalizeRelativeDirectory(route);
      const fullPath = normalizeRelativeDirectory([previousBasePath, routePath].filter(Boolean).join(path.sep));
      const rewrittenFullPath = replaceRelativeDirectoryPrefix(fullPath, previousPath, nextPath);
      if (rewrittenFullPath === fullPath) continue;
      const rewrittenRoute = relativeDirectoryFromBase(rewrittenFullPath, nextBasePath);
      if (rewrittenRoute !== null) {
        holder.routes[kind] = rewrittenRoute;
        changed = true;
      }
    }
  }
  holder.basePath = nextBasePath;
  return changed;
}

async function renameProjectDirectory({ projectId, path: folderPath, name }) {
  const project = await getProjectStrict(projectId);
  closeProjectWatchers(project.path);
  try {
    const folder = await renameProjectFolder({ projectPath: project.path, folderPath, name });
    if (folder.unchanged) {
      return {
        path: folder.relativePath,
        previousPath: folder.previousRelativePath,
        name: folder.name,
        previousName: folder.previousName,
        unchanged: true,
      };
    }

    try {
      await updateConfig((config) => {
        const configuredProject = config.projects.find((item) => item.id === project.id);
        if (!configuredProject) throw new Error(`项目不存在：${project.id}`);
        configuredProject.scanRoots = (configuredProject.scanRoots || [])
          .map((root) => ["", "."].includes(String(root || "").trim())
            ? root
            : replaceRelativeDirectoryPrefix(root, folder.previousRelativePath, folder.relativePath));

        if (config.automation?.inbox?.projectId === project.id) {
          rewriteAutomationDirectory(config.automation.inbox, folder.previousRelativePath, folder.relativePath);
        }
        for (const profile of config.automation?.routing?.profiles || []) {
          if (profile.projectId === project.id) {
            rewriteAutomationDirectory(profile, folder.previousRelativePath, folder.relativePath);
          }
        }
      });
    } catch (error) {
      try {
        await renameProjectFolder({
          projectPath: project.path,
          folderPath: folder.relativePath,
          name: folder.previousName,
        });
      } catch (rollbackError) {
        throw new Error(`${error.message || error}；文件夹改名回滚失败：${rollbackError.message || rollbackError}`);
      }
      throw error;
    }

    notifyClients("project-change");
    return {
      path: folder.relativePath,
      previousPath: folder.previousRelativePath,
      name: folder.name,
      previousName: folder.previousName,
      unchanged: false,
    };
  } finally {
    await ensureWatchers().catch(() => {});
  }
}

async function addProject({ name, path: projectPath, scanRoots }) {
  if (!projectPath) throw new Error("Missing project path");
  const absolutePath = safeProjectRoot(projectPath);
  if (!await exists(absolutePath)) throw new Error(`Project folder does not exist: ${absolutePath}`);
  const { result: project } = await updateConfig((config) => {
    const idBase = slugify(name || path.basename(absolutePath));
    let id = idBase;
    let counter = 2;
    while (config.projects.some((item) => item.id === id)) id = `${idBase}-${counter++}`;
    const createdProject = {
      id,
      name: name || path.basename(absolutePath),
      path: absolutePath,
      scanRoots: safeScanRoots(scanRoots)
    };
    config.projects.push(createdProject);
    return createdProject;
  });
  await ensureWatchers();
  notifyClients("project-change");
  return project;
}

async function reorderProjects(projectIds) {
  if (!Array.isArray(projectIds)) throw new Error("Missing project order");
  await updateConfig((config) => {
    const byId = new Map(config.projects.map((project) => [project.id, project]));
    const ordered = [];
    const seen = new Set();
    for (const id of projectIds) {
      if (!byId.has(id) || seen.has(id)) continue;
      ordered.push(byId.get(id));
      seen.add(id);
    }
    for (const project of config.projects) {
      if (!seen.has(project.id)) ordered.push(project);
    }
    config.projects = ordered;
  });
  return listProjects();
}

async function writeMetaOrRemove(caseDir, meta) {
  if (Object.keys(meta).length) {
    await writeMeta(caseDir, meta);
  } else {
    await fs.rm(path.join(caseDir, ".asset-review-meta.json"), { force: true });
  }
}

function caseContainsPath(caseId, relativePath) {
  if (caseId === "." || caseId === "") return true;
  const normalizedCase = path.normalize(caseId);
  const normalizedPath = path.normalize(relativePath);
  return normalizedPath === normalizedCase || normalizedPath.startsWith(normalizedCase + path.sep);
}

async function transferReviewMeta({ sourceProject, sourceCaseId, sourceAssetId, targetProject, targetRelativePath }) {
  if (!sourceCaseId || !sourceAssetId) return null;
  const sourceCaseDir = safeResolveProject(sourceProject, sourceCaseId);
  if (!await exists(sourceCaseDir)) return null;
  const sourceAssetPath = safeResolve(sourceCaseDir, sourceAssetId);
  await assertCaseMutationContained(sourceProject, sourceCaseDir, sourceAssetPath);
  const sourceKey = path.relative(sourceCaseDir, sourceAssetPath);
  const sourceMeta = await readMeta(sourceCaseDir);
  const annotation = sourceMeta[sourceKey];
  if (!annotation) return null;

  const targetCases = await listCases(targetProject.id);
  const targetCase = targetCases
    .filter((item) => caseContainsPath(item.id, targetRelativePath))
    .sort((a, b) => b.id.length - a.id.length)[0];
  if (!targetCase) return null;
  const targetCaseDir = safeResolveProject(targetProject, targetCase.id);
  const targetAssetPath = safeResolveProject(targetProject, targetRelativePath);
  await assertCaseMutationContained(targetProject, targetCaseDir, targetAssetPath);
  const targetKey = path.relative(targetCaseDir, targetAssetPath);

  const sameMetaFile = pathsEqual(sourceCaseDir, targetCaseDir);
  if (sameMetaFile) {
    delete sourceMeta[sourceKey];
    sourceMeta[targetKey] = annotation;
    await writeMetaOrRemove(sourceCaseDir, sourceMeta);
  } else {
    delete sourceMeta[sourceKey];
    await writeMetaOrRemove(sourceCaseDir, sourceMeta);
    const targetMeta = await readMeta(targetCaseDir);
    targetMeta[targetKey] = annotation;
    await writeMeta(targetCaseDir, targetMeta);
  }
  return { caseId: targetCase.id, assetId: targetKey };
}

function profileForTarget(config, targetProject, targetRelativePath) {
  const normalizedTarget = pathKey(path.normalize(targetRelativePath || ""));
  return (config.automation?.routing?.profiles || [])
    .filter((profile) => profile.projectId === targetProject.id)
    .map((profile) => {
      const basePath = path.normalize(String(profile.basePath || "").trim()).replace(/^\.[\\/]/, "");
      const normalizedBase = basePath === "." ? "" : pathKey(basePath);
      const matches = !normalizedBase || normalizedTarget === normalizedBase || isPathInside(normalizedBase, normalizedTarget);
      return matches ? { profile, length: normalizedBase.length } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0]?.profile || null;
}

async function updateMovedSidecars(destinationPath, sourceProject, sourcePath, targetProject, targetProfile) {
  const ext = path.extname(destinationPath);
  const destinationStem = destinationPath.slice(0, -ext.length);
  const promptPath = `${destinationStem}.prompt.md`;
  const metaPath = `${destinationStem}.meta.json`;
  const oldRelative = path.relative(sourceProject.path, sourcePath);
  const newRelative = path.relative(targetProject.path, destinationPath);

  if (await exists(promptPath)) {
    try {
      const prompt = await fs.readFile(promptPath, "utf8");
      await fs.writeFile(promptPath, prompt
        .split(oldRelative).join(newRelative)
        .split(sourceProject.name).join(targetProject.name), "utf8");
    } catch {}
  }
  if (await exists(metaPath)) {
    try {
      const meta = JSON.parse((await fs.readFile(metaPath, "utf8")).replace(/^\uFEFF/, ""));
      const context = {
        ticketId: String(meta.ticket?.id || ""),
        outputId: String(meta.output?.id || ""),
        threadId: String(meta.ticket?.sourceContext?.threadId || meta.ticket?.sourceContext?.taskId || ""),
        sourceTask: String(meta.ticket?.sourceContext?.sourceTask || meta.ticket?.sourceContext?.taskTitle || "")
      };
      if (meta.ticket && typeof meta.ticket === "object") {
        meta.ticket.projectId = targetProject.id;
        meta.ticket.projectName = targetProject.name;
        meta.ticket.profileId = targetProfile?.id || "";
        meta.ticket.profileName = targetProfile?.name || "";
        meta.ticket.destinationRelativePath = path.dirname(newRelative);
        meta.ticket.routingResolution = {
          source: "manual-move",
          confidence: "high",
          matchedKeyword: "",
          matchedOn: "",
          threadId: context.threadId
        };
      }
      if (meta.output && typeof meta.output === "object") {
        meta.output.path = destinationPath;
        meta.output.relativePath = newRelative;
        meta.output.fileName = path.basename(destinationPath);
        meta.output.promptPath = promptPath;
        meta.output.metaPath = metaPath;
      }
      if (meta.project && typeof meta.project === "object") {
        meta.project.id = targetProject.id;
        meta.project.name = targetProject.name;
        meta.project.path = targetProject.path;
      }
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
      return context;
    } catch {}
  }
  return null;
}

async function moveAsset(body) {
  const config = await loadConfig();
  const sourceProject = await getProjectStrict(body.sourceProjectId);
  const targetProject = await getProjectStrict(body.targetProjectId);
  const sourcePath = safeResolveProject(sourceProject, body.sourcePath);
  await assertRealPathContained(sourceProject.path, sourcePath);
  assertCreativeSourceMutationAllowed(sourceProject, sourcePath);
  const sourceStats = await fs.lstat(sourcePath);
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) throw new Error("只能移动普通素材文件");

  const targetDirectory = safeResolveProject(targetProject, body.targetDirectory || "");
  await assertRealPathContained(targetProject.path, targetDirectory, { allowMissing: true });
  await fs.mkdir(targetDirectory, { recursive: true });
  await assertRealPathContained(targetProject.path, targetDirectory);
  const sourceExt = path.extname(sourcePath);
  const requestedName = String(body.fileName || path.basename(sourcePath)).trim();
  const requestedStem = cleanFileStem(path.basename(requestedName, path.extname(requestedName)), path.basename(sourcePath, sourceExt));
  const desiredPath = path.join(targetDirectory, `${requestedStem}${sourceExt}`);
  if (pathsEqual(desiredPath, sourcePath)) {
    throw new Error("素材已经在这个位置，请选择其他文件夹或修改文件名");
  }
  const destinationPath = await uniqueAssetPath(desiredPath);
  const sourceStem = sourcePath.slice(0, -sourceExt.length);
  const destinationStem = destinationPath.slice(0, -sourceExt.length);
  const mappings = [{ source: sourcePath, destination: destinationPath, role: "asset" }];
  for (const suffix of [".prompt.md", ".meta.json"]) {
    const sidecarSource = `${sourceStem}${suffix}`;
    if (await exists(sidecarSource)) {
      await assertRealPathContained(sourceProject.path, sidecarSource);
      const sidecarStats = await fs.lstat(sidecarSource);
      if (!sidecarStats.isFile() || sidecarStats.isSymbolicLink()) throw new Error(`素材伴随文件不是普通文件：${path.basename(sidecarSource)}`);
      mappings.push({ source: sidecarSource, destination: `${destinationStem}${suffix}`, role: suffix.slice(1) });
    }
  }

  const staged = [];
  try {
    for (const mapping of mappings) {
      const temporaryPath = path.join(path.dirname(mapping.destination), `.${path.basename(mapping.destination)}.${process.pid}.${Date.now()}.moving`);
      await fs.copyFile(mapping.source, temporaryPath);
      const [sourceHash, copiedHash] = await Promise.all([hashFile(mapping.source), hashFile(temporaryPath)]);
      if (sourceHash !== copiedHash) throw new Error(`移动校验失败：${path.basename(mapping.source)}`);
      staged.push({ ...mapping, temporaryPath, sha256: sourceHash });
    }
    for (const mapping of staged) await fs.rename(mapping.temporaryPath, mapping.destination);
  } catch (error) {
    for (const mapping of staged) await fs.rm(mapping.temporaryPath, { force: true }).catch(() => {});
    throw error;
  }

  for (const mapping of mappings) await fs.rm(mapping.source, { force: false });
  const targetRelativePath = path.relative(targetProject.path, destinationPath);
  const targetProfile = profileForTarget(config, targetProject, targetRelativePath);
  const movedGeneration = await updateMovedSidecars(destinationPath, sourceProject, sourcePath, targetProject, targetProfile);
  let ticketRelocation = null;
  let taskBinding = null;
  let routingCorrectionError = "";
  if (movedGeneration?.ticketId) {
    try {
      ticketRelocation = await generationPipeline.relocateArchivedOutput(movedGeneration.ticketId, {
        projectId: targetProject.id,
        profileId: targetProfile?.id || "",
        oldPath: sourcePath,
        newPath: destinationPath,
        outputId: movedGeneration.outputId
      }, config);
      const metaPath = `${destinationStem}.meta.json`;
      if (await exists(metaPath)) {
        const meta = JSON.parse((await fs.readFile(metaPath, "utf8")).replace(/^\uFEFF/, ""));
        meta.ticket = { ...ticketRelocation.ticket, outputs: undefined, inboxBaseline: undefined };
        meta.output = ticketRelocation.output;
        meta.project = { id: targetProject.id, name: targetProject.name, path: targetProject.path };
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
      }
      const ledgerDir = path.join(targetProject.path, "生成记录");
      await fs.mkdir(ledgerDir, { recursive: true });
      await fs.appendFile(path.join(ledgerDir, "生成资产台账.jsonl"), JSON.stringify({
        schemaVersion: 1,
        event: "relocated",
        ticketId: movedGeneration.ticketId,
        projectId: targetProject.id,
        profileId: targetProfile?.id || "",
        previous: ticketRelocation.previous,
        output: ticketRelocation.output,
        movedAt: ticketRelocation.movedAt
      }) + "\n", "utf8");
    } catch (error) {
      routingCorrectionError = String(error.message || error);
    }
  }
  const canBindTarget = movedGeneration?.threadId
    && !["pending-review", "misc-library", "ai-reference-library", "reference-library"].includes(targetProject.id);
  if (canBindTarget) {
    try {
      taskBinding = await generationPipeline.bindThread({
        threadId: movedGeneration.threadId,
        projectId: targetProject.id,
        profileId: targetProfile?.id || "",
        source: "manual-asset-move",
        sourceTask: movedGeneration.sourceTask
      }, config);
    } catch (error) {
      routingCorrectionError ||= String(error.message || error);
    }
  }
  const reviewMeta = await transferReviewMeta({
    sourceProject,
    sourceCaseId: body.sourceCaseId,
    sourceAssetId: body.sourceAssetId,
    targetProject,
    targetRelativePath
  });
  return {
    sourceProjectId: sourceProject.id,
    sourcePath,
    sourceRelativePath: path.relative(sourceProject.path, sourcePath),
    sourceFileName: path.basename(sourcePath),
    targetProjectId: targetProject.id,
    targetProjectName: targetProject.name,
    destinationPath,
    targetRelativePath,
    fileName: path.basename(destinationPath),
    movedSidecars: staged.filter((item) => item.role !== "asset").map((item) => item.role),
    reviewMeta,
    taskBinding,
    ticketRelocation: ticketRelocation ? { ticketId: movedGeneration.ticketId, movedAt: ticketRelocation.movedAt } : null,
    routingCorrectionError
  };
}

async function batchMoveAssets(body) {
  if (!Array.isArray(body.items) || !body.items.length) throw new Error("没有可移动的素材");
  const results = [];
  const errors = [];
  for (const item of body.items.slice(0, 200)) {
    try {
      results.push(await moveAsset({
        ...item,
        targetProjectId: item.targetProjectId || body.targetProjectId,
        targetDirectory: item.targetDirectory ?? body.targetDirectory,
        fileName: item.fileName || path.basename(item.sourcePath || "")
      }));
    } catch (error) {
      errors.push({ sourcePath: item.sourcePath || "", message: String(error.message || error) });
    }
  }
  return { results, errors };
}

async function markAsset(body) {
  const project = await getProjectStrict(body.projectId);
  const caseDir = safeResolveProject(project, body.caseId);
  const assetPath = safeResolve(caseDir, body.assetId);
  await assertCaseMutationContained(project, caseDir, assetPath);
  const relToCase = path.relative(caseDir, assetPath);
  const meta = await readMeta(caseDir);
  const previous = meta[relToCase] || {};
  meta[relToCase] = {
    ...previous,
    userStatus: body.userStatus || "",
    notes: body.notes || "",
    favorite: Boolean(body.favorite),
    tags: Array.isArray(body.tags) ? body.tags : [],
    updatedAt: new Date().toISOString()
  };
  await writeMeta(caseDir, meta);
  return { projectId: project.id, caseId: body.caseId, assetId: relToCase, previous, meta: meta[relToCase] };
}

async function batchMarkAssets(body) {
  if (!Array.isArray(body.items) || !body.items.length) throw new Error("没有可标记的素材");
  const results = [];
  const errors = [];
  for (const item of body.items.slice(0, 500)) {
    try {
      results.push(await markAsset(item));
    } catch (error) {
      errors.push({ assetId: item.assetId || "", message: String(error.message || error) });
    }
  }
  return { results, errors };
}

function scheduleTrashPurge(tokenDirectory, delayMs = 15 * 60 * 1000) {
  const timer = setTimeout(() => fs.rm(tokenDirectory, { recursive: true, force: true }).catch(() => {}), delayMs);
  timer.unref?.();
}

async function trashAssets(body) {
  if (!Array.isArray(body.items) || !body.items.length) throw new Error("没有可删除的素材");
  const requestedItems = body.items.slice(0, 200);
  const plans = [];
  const seenSources = new Set();
  const metadataPlans = new Map();

  for (const item of requestedItems) {
    const project = await getProjectStrict(item.projectId);
    const sourcePath = safeResolveProject(project, item.sourcePath);
    await assertRealPathContained(project.path, sourcePath);
    assertCreativeSourceMutationAllowed(project, sourcePath);
    const stats = await fs.lstat(sourcePath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`只能删除普通素材文件：${item.sourcePath}`);
    const sourceExt = path.extname(sourcePath);
    const sourceStem = sourcePath.slice(0, -sourceExt.length);
    const mappings = [{ source: sourcePath, name: path.basename(sourcePath), role: "asset" }];
    for (const suffix of [".prompt.md", ".meta.json"]) {
      const sidecar = `${sourceStem}${suffix}`;
      if (await exists(sidecar)) {
        await assertRealPathContained(project.path, sidecar);
        assertCreativeSourceMutationAllowed(project, sidecar);
        const sidecarStats = await fs.lstat(sidecar);
        if (!sidecarStats.isFile() || sidecarStats.isSymbolicLink()) {
          throw new Error(`素材伴随文件不是普通文件：${path.basename(sidecar)}`);
        }
        mappings.push({ source: sidecar, name: path.basename(sidecar), role: suffix.slice(1) });
      }
    }
    for (const mapping of mappings) {
      const key = pathKey(mapping.source);
      if (seenSources.has(key)) throw new Error(`删除清单包含重复文件：${path.basename(mapping.source)}`);
      seenSources.add(key);
    }

    let reviewMeta = null;
    if (item.caseId && item.assetId) {
      const caseDir = safeResolveProject(project, item.caseId);
      const assetPath = safeResolve(caseDir, item.assetId);
      await assertCaseMutationContained(project, caseDir, assetPath);
      if (!pathsEqual(assetPath, sourcePath)) throw new Error("删除目标与评审元数据目标不一致");
      const key = path.relative(caseDir, assetPath);
      const metadataKey = `${project.id}\u0000${pathKey(caseDir)}`;
      if (!metadataPlans.has(metadataKey)) {
        const before = await readMeta(caseDir);
        metadataPlans.set(metadataKey, { project, caseDir, before, next: { ...before } });
      }
      const metadataPlan = metadataPlans.get(metadataKey);
      if (metadataPlan.before[key]) {
        reviewMeta = { caseId: item.caseId, assetId: key, value: metadataPlan.before[key] };
        delete metadataPlan.next[key];
      }
    }
    plans.push({ project, sourcePath, sourcePathInput: item.sourcePath, mappings, reviewMeta });
  }

  const token = randomUUID();
  const tokenDirectory = safeResolve(actionTrashRoot, token);
  const storedItems = [];
  await fs.mkdir(tokenDirectory, { recursive: true });

  try {
    for (const [index, plan] of plans.entries()) {
      const storedDirectory = path.join(tokenDirectory, "files", String(index));
      await fs.mkdir(storedDirectory, { recursive: true });
      const storedMappings = [];
      for (const mapping of plan.mappings) {
        const storedPath = path.join(storedDirectory, mapping.name);
        await fs.copyFile(mapping.source, storedPath);
        const [sourceHash, storedHash] = await Promise.all([hashFile(mapping.source), hashFile(storedPath)]);
        if (sourceHash !== storedHash) throw new Error(`删除前校验失败：${mapping.name}`);
        storedMappings.push({ ...mapping, storedPath: path.relative(tokenDirectory, storedPath), sha256: sourceHash });
      }
      storedItems.push({
        projectId: plan.project.id,
        sourcePath: plan.sourcePathInput,
        mappings: storedMappings,
        reviewMeta: plan.reviewMeta
      });
    }

    const manifest = { token, createdAt: new Date().toISOString(), items: storedItems };
    await fs.writeFile(path.join(tokenDirectory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

    const removed = [];
    const rollbackRemoved = async () => {
      for (const mapping of [...removed].reverse()) {
        if (await exists(mapping.source)) continue;
        await fs.mkdir(path.dirname(mapping.source), { recursive: true });
        const storedPath = safeResolve(tokenDirectory, mapping.storedPath);
        const temporary = `${mapping.source}.${process.pid}.${randomUUID()}.trash-rollback`;
        await fs.copyFile(storedPath, temporary);
        if (await hashFile(temporary) !== mapping.sha256) {
          await fs.rm(temporary, { force: true });
          throw new Error(`删除回滚校验失败：${path.basename(mapping.source)}`);
        }
        await fs.rename(temporary, mapping.source);
      }
    };

    try {
      for (const item of storedItems) {
        for (const mapping of item.mappings) {
          await fs.rm(mapping.source, { force: false });
          removed.push(mapping);
        }
      }
      for (const metadataPlan of metadataPlans.values()) {
        await assertCaseMutationContained(metadataPlan.project, metadataPlan.caseDir);
        await writeMetaOrRemove(metadataPlan.caseDir, metadataPlan.next);
      }
    } catch (error) {
      await rollbackRemoved();
      for (const metadataPlan of metadataPlans.values()) {
        await writeMetaOrRemove(metadataPlan.caseDir, metadataPlan.before);
      }
      throw error;
    }
    scheduleTrashPurge(tokenDirectory);
    return { token, count: storedItems.length, expiresInMs: 15 * 60 * 1000 };
  } catch (error) {
    await fs.rm(tokenDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function restoreTrashedAssets(body) {
  const token = String(body.token || "").trim();
  if (!token) throw new Error("缺少撤销记录");
  const tokenDirectory = safeResolve(actionTrashRoot, token);
  await assertRealPathContained(actionTrashRoot, tokenDirectory);
  const manifest = JSON.parse((await fs.readFile(path.join(tokenDirectory, "manifest.json"), "utf8")).replace(/^\uFEFF/, ""));
  if (manifest.token !== token || !Array.isArray(manifest.items)) throw new Error("撤销记录损坏或不匹配");

  const prepared = [];
  const destinationKeys = new Set();
  for (const item of manifest.items || []) {
    const project = await getProjectStrict(item.projectId);
    for (const mapping of item.mappings || []) {
      const storedPath = safeResolve(tokenDirectory, mapping.storedPath);
      await assertRealPathContained(tokenDirectory, storedPath);
      const storedStats = await fs.lstat(storedPath);
      if (!storedStats.isFile() || storedStats.isSymbolicLink()) throw new Error("撤销副本不是普通文件");
      const destination = safeResolveProject(project, path.relative(project.path, mapping.source));
      await assertRealPathContained(project.path, destination, { allowMissing: true });
      const destinationKey = pathKey(destination);
      if (destinationKeys.has(destinationKey)) throw new Error("撤销记录包含重复目标");
      destinationKeys.add(destinationKey);
      if (await exists(destination)) throw new Error(`原位置已有同名文件，无法撤销：${path.basename(destination)}`);
      prepared.push({ project, item, mapping, storedPath, destination, temporary: "" });
    }
  }

  const committed = [];
  try {
    for (const entry of prepared) {
      await fs.mkdir(path.dirname(entry.destination), { recursive: true });
      await assertRealPathContained(entry.project.path, path.dirname(entry.destination));
      entry.temporary = `${entry.destination}.${process.pid}.${randomUUID()}.restoring`;
      await fs.copyFile(entry.storedPath, entry.temporary);
      if (await hashFile(entry.temporary) !== entry.mapping.sha256) {
        throw new Error(`撤销校验失败：${path.basename(entry.destination)}`);
      }
    }
    for (const entry of prepared) {
      await fs.rename(entry.temporary, entry.destination);
      entry.temporary = "";
      committed.push(entry);
    }
    for (const item of manifest.items || []) {
      if (!item.reviewMeta) continue;
      const project = await getProjectStrict(item.projectId);
      const caseDir = safeResolveProject(project, item.reviewMeta.caseId);
      await assertCaseMutationContained(project, caseDir);
      const meta = await readMeta(caseDir);
      meta[item.reviewMeta.assetId] = item.reviewMeta.value;
      await writeMeta(caseDir, meta);
    }
  } catch (error) {
    for (const entry of prepared) {
      if (entry.temporary) await fs.rm(entry.temporary, { force: true }).catch(() => {});
    }
    for (const entry of [...committed].reverse()) await fs.rm(entry.destination, { force: true }).catch(() => {});
    throw error;
  }
  await fs.rm(tokenDirectory, { recursive: true, force: true });
  return { token, count: manifest.items?.length || 0 };
}

async function appendCaseDirectories({ project, scanRoot, rootDir, currentDir = rootDir, depth = 1, maxDepth = 1, cases }) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const caseDir = path.join(currentDir, entry.name);
    const stats = await fs.stat(caseDir);
    const relPath = path.relative(project.path, caseDir);
    cases.push({
      id: relPath,
      projectId: project.id,
      name: entry.name.replace(/^\d{4}-\d{2}-\d{2}-/, ""),
      relPath,
      scanRoot,
      mediaCount: await countMediaFiles(caseDir),
      mtimeMs: stats.mtimeMs
    });
    if (depth < maxDepth) {
      await appendCaseDirectories({ project, scanRoot, rootDir, currentDir: caseDir, depth: depth + 1, maxDepth, cases });
    }
  }
}

async function listCases(projectId) {
  const project = await getProjectStrict(projectId);
  const cases = [];
  for (const scanRoot of project.scanRoots) {
    const rootDir = safeResolveProject(project, scanRoot);
    if (!await exists(rootDir)) continue;
    const rootStats = await fs.stat(rootDir);
    if (await directoryHasMedia(rootDir)) {
      const rootRelPath = path.relative(project.path, rootDir) || ".";
      cases.push({
        id: rootRelPath,
        projectId: project.id,
        name: path.basename(rootDir),
        relPath: rootRelPath,
        scanRoot,
        mediaCount: await countMediaFiles(rootDir),
        mtimeMs: rootStats.mtimeMs
      });
    }
    const maxDepth = ["ai-reference-library", "reference-library"].includes(project.id) ? 5 : 1;
    await appendCaseDirectories({ project, scanRoot, rootDir, maxDepth, cases });
  }
  return cases.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function listAssets(projectId, caseId) {
  const project = await getProjectStrict(projectId);
  const caseDir = safeResolveProject(project, caseId);
  if (!await exists(caseDir)) throw new Error(`Case not found: ${caseId}`);
  const files = await walk(caseDir);
  const meta = await readMeta(caseDir);
  const assets = [];
  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    if (!imageExts.has(ext) && !videoExts.has(ext) && !audioExts.has(ext)) continue;
    const stats = await fs.stat(filePath);
    const relToCase = path.relative(caseDir, filePath);
    const relToProject = path.relative(project.path, filePath);
    const kind = assetKind(filePath, caseDir);
    const stored = meta[relToCase] || {};
    assets.push({
      id: relToCase,
      projectId: project.id,
      projectName: project.name,
      caseId,
      kind,
      version: inferVersion(relToCase),
      name: path.basename(filePath),
      relPath: relToProject,
      caseRelPath: relToCase,
      dir: path.dirname(relToProject),
      mediaUrl: `/media?project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(relToProject)}`,
      downloadUrl: `/download?project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(relToProject)}`,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      mtime: new Date(stats.mtimeMs).toISOString(),
      initialStatus: initialStatus(relToCase),
      userStatus: stored.userStatus || "",
      notes: stored.notes || "",
      favorite: Boolean(stored.favorite),
      tags: stored.tags || []
    });
  }
  return assets.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function canvasBoardForClient(board) {
  return {
    ...board,
    nodes: board.nodes.map((node) => node.kind === "asset"
      ? {
          ...node,
          mediaUrl: `/media?project=${encodeURIComponent(board.projectId)}&path=${encodeURIComponent(node.ref.relPath)}`,
          downloadUrl: `/download?project=${encodeURIComponent(board.projectId)}&path=${encodeURIComponent(node.ref.relPath)}`
        }
      : node)
  };
}

async function serveFile(req, res, filePath, asDownload = false, extraHeaders = {}) {
  const stats = await fs.stat(filePath);
  const headers = {
    "content-type": contentType(filePath),
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    ...extraHeaders
  };
  if (asDownload) {
    headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`;
  }

  const range = req.headers.range;
  if (range && !asDownload) {
    const match = String(range).match(/^bytes=(\d+)-(\d*)$/);
    const start = match ? Number(match[1]) : Number.NaN;
    const requestedEnd = match?.[2] ? Number(match[2]) : stats.size - 1;
    const end = Math.min(requestedEnd, stats.size - 1);
    if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stats.size) {
      res.writeHead(416, { ...headers, "content-range": `bytes */${stats.size}`, "content-length": 0 });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      "content-range": `bytes ${start}-${end}/${stats.size}`,
      "content-length": end - start + 1
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, "content-length": stats.size });
  createReadStream(filePath).pipe(res);
}

async function readRequestBody(req, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const error = new Error("Request body exceeds the 4 MB local API limit");
    error.statusCode = 413;
    throw error;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("Request body exceeds the 4 MB local API limit");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function openFinder(targetPath, reveal = true) {
  let command;
  let args;
  if (process.platform === "win32") {
    command = "explorer.exe";
    args = reveal ? ["/select,", targetPath] : [targetPath];
  } else if (process.platform === "darwin") {
    command = "open";
    args = reveal ? ["-R", targetPath] : [targetPath];
  } else {
    command = "xdg-open";
    args = [reveal ? path.dirname(targetPath) : targetPath];
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
}

function localDateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function readRhythmControlRegistry() {
  try {
    const data = JSON.parse((await fs.readFile(rhythmControlRegistryPath, "utf8")).replace(/^\uFEFF/, ""));
    return {
      schemaVersion: 1,
      tracks: Array.isArray(data.tracks) ? data.tracks : [],
      activeByProject: data.activeByProject && typeof data.activeByProject === "object" ? data.activeByProject : {}
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { schemaVersion: 1, tracks: [], activeByProject: {} };
  }
}

async function writeRhythmControlRegistry(registry) {
  await fs.mkdir(path.dirname(rhythmControlRegistryPath), { recursive: true });
  const temporary = `${rhythmControlRegistryPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({
    schemaVersion: 1,
    tracks: (registry.tracks || []).slice(0, 200),
    activeByProject: registry.activeByProject || {}
  }, null, 2) + "\n", "utf8");
  await fs.rename(temporary, rhythmControlRegistryPath);
}

async function updateRhythmControlRegistry(mutator) {
  const operation = rhythmRegistryQueue.then(async () => {
    const registry = await readRhythmControlRegistry();
    const result = await mutator(registry);
    await writeRhythmControlRegistry(registry);
    return result;
  });
  rhythmRegistryQueue = operation.then(() => undefined, () => undefined);
  return await operation;
}

async function runRhythmControlBuilder(payload) {
  if (!await exists(rhythmControlScriptPath)) throw new Error("节奏控制轨生成器缺失");
  const tempRoot = path.join(assetBrowserRoot, "rhythm-control-work");
  await fs.mkdir(tempRoot, { recursive: true });
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const payloadPath = path.join(tempRoot, `${runId}.payload.json`);
  const resultPath = path.join(tempRoot, `${runId}.result.json`);
  await fs.writeFile(payloadPath, JSON.stringify(payload, null, 2), "utf8");

  try {
    const python = await runPythonCommand([
      rhythmControlScriptPath,
      "--payload", payloadPath,
      "--result", resultPath
    ], {
      cwd: __dirname,
      timeout: 12 * 60 * 1000,
      timeoutMessage: "节奏控制轨生成超时",
      maxBuffer: 8 * 1024 * 1024
    });
    const result = await exists(resultPath)
      ? JSON.parse((await fs.readFile(resultPath, "utf8")).replace(/^\uFEFF/, ""))
      : null;
    if (python.code !== 0 || !result?.ok) {
      throw new Error(result?.error || python.stderr.trim() || python.stdout.trim() || "节奏控制轨生成失败");
    }
    return result;
  } finally {
    await fs.rm(payloadPath, { force: true }).catch(() => {});
    await fs.rm(resultPath, { force: true }).catch(() => {});
  }
}

async function rhythmControlCapabilities() {
  let sfxCount = 0;
  const catalogPath = path.join(audioSkillRoot, "references", "sfx-catalog.json");
  try {
    const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
    sfxCount = Number(catalog.total || catalog.entries?.length || 0);
  } catch {}
  let musicReady = false;
  try {
    const response = await fetch("http://127.0.0.1:8001/health", { signal: AbortSignal.timeout(1500) });
    const health = await response.json();
    musicReady = response.ok && (health.data?.status || health.status) === "ok";
  } catch {}
  return {
    sfxCount,
    sfxReady: sfxCount > 0,
    musicReady,
    musicCanAutoStart: await exists(aceStepLauncher)
  };
}

function rhythmControlDestination(project, profile, body) {
  if (String(body.destinationPath || "").trim()) return String(body.destinationPath).trim();
  const date = localDateStamp();
  if (profile?.basePath) return path.join(profile.basePath, "节奏控制轨", date);
  return path.join("节奏控制轨", date);
}

async function createRhythmControlTrack(body) {
  const config = await loadConfig();
  const project = await getProjectStrict(body.projectId);
  const profile = config.automation?.routing?.profiles?.find((item) => item.id === body.profileId && item.projectId === project.id) || null;
  const destinationRelativePath = rhythmControlDestination(project, profile, body);
  const outputDir = safeResolveProject(project, destinationRelativePath);
  const duration = Number(body.duration || 0);
  if (!Number.isFinite(duration) || duration < 2 || duration > 180) throw new Error("目标时长应在 2–180 秒之间");
  const cues = Array.isArray(body.cues) ? body.cues : [];
  if (cues.length > 200) throw new Error("节奏点不能超过 200 个");
  const normalizedCues = cues.map((cue) => ({
    time: Number(cue?.time || 0),
    type: String(cue?.type || "").slice(0, 32),
    label: String(cue?.label || "节奏点").slice(0, 200)
  }));
  const result = await runRhythmControlBuilder({
    projectRoot: project.path,
    projectId: project.id,
    projectName: project.name || project.id,
    profileId: profile?.id || "",
    outputDir,
    name: body.name,
    duration,
    mode: body.mode || "sfx",
    bpm: Number(body.bpm || 96),
    keyScale: body.keyScale || "D minor",
    timeSignature: body.timeSignature || "4",
    description: body.description || "",
    musicPrompt: body.musicPrompt || "",
    cues: normalizedCues,
    apiUrl: "http://127.0.0.1:8001",
    audioSkillRoot,
    sfxCatalog: path.join(audioSkillRoot, "references", "sfx-catalog.json"),
    musicGeneratorScript: path.join(audioSkillRoot, "scripts", "generate_music_acestep.py"),
    aceStepLauncher,
    workRoot: path.join(assetBrowserRoot, "rhythm-control-work", "renders")
  });
  const trackPath = safeResolveProject(project, result.track.relativePath);
  if (!await exists(trackPath)) throw new Error("控制轨生成结束，但没有找到输出文件");
  const track = {
    ...result.track,
    projectId: project.id,
    projectName: project.name || project.id,
    profileId: profile?.id || "",
    destinationRelativePath,
    mediaUrl: `/media?project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(result.track.relativePath)}`
  };
  await updateRhythmControlRegistry((registry) => {
    registry.tracks = [track, ...registry.tracks.filter((item) => item.id !== track.id)];
    registry.activeByProject[project.id] = track.id;
  });
  return track;
}

async function rhythmControlStatus(projectId = "") {
  const registry = await readRhythmControlRegistry();
  const tracks = registry.tracks
    .filter((track) => !projectId || track.projectId === projectId)
    .filter((track) => track.absolutePath && path.isAbsolute(track.absolutePath))
    .slice(0, 40);
  return {
    capabilities: await rhythmControlCapabilities(),
    activeTrackId: projectId ? registry.activeByProject[projectId] || "" : "",
    tracks
  };
}

async function saveAutomationSettings(body) {
  const { saved } = await updateConfig((config) => {
  const automation = normalizeAutomation(body.automation || body);
  const previouslyEnabled = Boolean(config.automation?.inbox?.enabled);
  if (automation.inbox.enabled && !previouslyEnabled) {
    automation.inbox.startedAt = new Date().toISOString();
  } else if (automation.inbox.enabled) {
    automation.inbox.startedAt = automation.inbox.startedAt || config.automation?.inbox?.startedAt || new Date().toISOString();
  } else {
    automation.inbox.startedAt = null;
  }
  if (automation.inbox.transferMode === "move") {
    if (body.confirmMove === true) {
      automation.inbox.moveApprovedAt = new Date().toISOString();
    } else if (!automation.inbox.moveApprovedAt) {
      throw new Error("启用自动转移前需要明确确认");
    }
  } else {
    automation.inbox.moveApprovedAt = null;
  }
  if (automation.inbox.enabled && automation.routing.enabled) {
    const projectIds = new Set(config.projects.map((project) => project.id));
    const missing = automation.routing.profiles.find((profile) => !projectIds.has(profile.projectId));
    if (missing) throw new Error(`分流规则的目标项目不存在：${missing.name}`);
    if (!automation.routing.profiles.some((profile) => profile.id === automation.routing.activeProfileId)) {
      throw new Error("请选择一个有效的当前下载项目");
    }
  } else if (automation.inbox.enabled && !config.projects.some((project) => project.id === automation.inbox.projectId)) {
    throw new Error("自动归档已开启，但尚未选择有效的目标项目");
  }

  if (automation.cleanup.enabled && !automation.cleanup.dryRun) {
    if (body.confirmCleanup !== true) throw new Error("启用实际清理前需要明确确认");
    automation.cleanup.approvedAt = new Date().toISOString();
  } else {
    automation.cleanup.approvedAt = null;
  }

  if (automation.cleanup.purgeEnabled) {
    if (body.confirmPurge !== true) throw new Error("启用隔离区永久清空前需要单独确认");
    automation.cleanup.purgeApprovedAt = new Date().toISOString();
  } else {
    automation.cleanup.purgeApprovedAt = null;
  }

  config.automation = automation;
  });
  notifyClients("automation-change");
  return saved.automation;
}

async function withAutomationLock(operation) {
  if (automationBusy) throw new Error("下载整理任务正在运行，请稍后再试");
  automationBusy = true;
  try {
    return await operation();
  } finally {
    automationBusy = false;
  }
}

async function checkAutomationSchedule() {
  if (automationBusy) return;
  automationBusy = true;
  try {
    const config = await loadConfig();
    const generationClaims = await generationPipeline.claimArmedDownloads(config, {
      settleSeconds: Math.min(6, Math.max(2, config.automation.inbox.settleSeconds || 4))
    });
    if (generationClaims.length) notifyClients("generation-change");
    const ledger = await downloadAutomation.readLedger();
    const now = Date.now();
    const organizerDue = !ledger.lastOrganizerRunAt || now - Date.parse(ledger.lastOrganizerRunAt) >= config.automation.inbox.pollSeconds * 1000;
    if (config.automation.inbox.enabled && organizerDue) {
      const result = await downloadAutomation.runOrganizer(config.automation, config.projects);
      if (result.imported.length) notifyClients("automation-change");
    }

    const latestLedger = await downloadAutomation.readLedger();
    const cleanupDue = !latestLedger.lastCleanupRunAt || now - Date.parse(latestLedger.lastCleanupRunAt) >= config.automation.cleanup.intervalHours * 60 * 60 * 1000;
    if (
      config.automation.cleanup.enabled &&
      !config.automation.cleanup.dryRun &&
      config.automation.cleanup.approvedAt &&
      cleanupDue
    ) {
      const result = await downloadAutomation.runCleanup(config.automation);
      if (result.quarantined?.length || result.purged?.length) notifyClients("automation-change");
    }
  } catch (error) {
    console.warn("Download automation:", error.message);
  } finally {
    automationBusy = false;
  }
}

function notifyClients(event = "asset-change") {
  const payload = JSON.stringify({ event, at: new Date().toISOString() });
  for (const client of sseClients) {
    client.write(`event: ${event}\n`);
    client.write(`data: ${payload}\n\n`);
  }
}

function scheduleNotify() {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => notifyClients(), 600);
}

async function runDuplicateSweep() {
  try {
    const config = await loadConfig();
    const result = await duplicateCleaner.sweepProjects(config.projects, config.deduplication);
    if (result.quarantined.length || result.purged.length) notifyClients("deduplication-change");
    if (result.quarantined.length) console.log(`Exact duplicate images quarantined: ${result.quarantined.length}`);
  } catch (error) {
    console.warn("Exact duplicate cleanup:", error.message);
  }
}

async function ensureWatchers() {
  const config = await loadConfig();
  for (const project of config.projects) {
    for (const scanRoot of project.scanRoots) {
      const watchRoot = safeResolveProject(project, scanRoot);
      if (!await exists(watchRoot)) continue;
      if (watcherHandles.has(watchRoot)) continue;
      try {
        const watcher = watch(watchRoot, { recursive: true }, (_eventType, filename) => {
          scheduleNotify();
          if (!filename) return;
          const changedPath = path.resolve(watchRoot, String(filename));
          duplicateCleaner.schedule({
            filePath: changedPath,
            project,
            config: config.deduplication,
            onDeduplicated: () => notifyClients("deduplication-change")
          });
        });
        watcher.on("error", (error) => {
          console.warn(`Asset watcher error (${watchRoot}):`, error.message);
        });
        watcherHandles.set(watchRoot, watcher);
        console.log(`Watching assets: ${watchRoot}`);
      } catch (error) {
        console.warn(`Asset watcher unavailable (${watchRoot}):`, error.message);
      }
    }
  }
}

function closeProjectWatchers(projectPath) {
  const projectRoot = path.resolve(projectPath);
  for (const [watchRoot, watcher] of watcherHandles) {
    const relative = path.relative(projectRoot, path.resolve(watchRoot));
    const belongsToProject = relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    if (!belongsToProject) continue;
    watcher.close();
    watcherHandles.delete(watchRoot);
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "OPTIONS") {
      const origin = String(req.headers.origin || "");
      if (!isAllowedLocalOrigin(req)) {
        sendJson(res, { error: "Origin is not allowed" }, 403);
        return;
      }
      res.writeHead(204, {
        "access-control-allow-origin": origin || `http://127.0.0.1:${port}`,
        "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type,x-asset-console-token",
        vary: "origin"
      });
      res.end();
      return;
    }

    if (isProtectedLocalRoute(url.pathname) && (!isAllowedLocalOrigin(req) || (!hasValidApiToken(req) && !hasValidBrowserSession(req)))) {
      sendJson(res, { error: "Local API authentication failed" }, 403);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.setHeader("set-cookie", browserSessionCookie);
    }

    if (url.pathname === "/api/prompt-library/health" && req.method === "GET") {
      sendJson(res, await promptLibrary.health());
      return;
    }

    if (url.pathname === "/api/prompt-library" && req.method === "GET") {
      sendJson(res, await promptLibrary.list({
        kind: url.searchParams.get("kind") || "",
        query: url.searchParams.get("query") || "",
        category: url.searchParams.get("category") || "",
        projectId: url.searchParams.get("project") || "",
        reviewStatus: url.searchParams.get("reviewStatus") || ""
      }));
      return;
    }

    if (url.pathname === "/api/prompt-library/compile" && req.method === "POST") {
      const result = await promptLibrary.compile();
      notifyClients("prompt-library-change");
      sendJson(res, { ok: true, ...result });
      return;
    }

    if (url.pathname === "/api/prompt-library/captures" && req.method === "POST") {
      const body = await readRequestBody(req);
      const result = await promptLibrary.create("capture", body);
      notifyClients("prompt-library-change");
      const origin = String(req.headers.origin || "");
      if (origin.startsWith("chrome-extension://")) res.setHeader("access-control-allow-origin", origin);
      sendJson(res, { ok: true, ...result });
      return;
    }

    if (url.pathname === "/api/prompt-library/items" && req.method === "POST") {
      const body = await readRequestBody(req);
      const result = await promptLibrary.create(String(body.kind || "capture"), body);
      notifyClients("prompt-library-change");
      sendJson(res, { ok: true, ...result });
      return;
    }

    const promptItemMatch = url.pathname.match(/^\/api\/prompt-library\/items\/(capture|term|recipe|prompt)\/([^/]+)$/);
    if (promptItemMatch && (req.method === "PUT" || req.method === "DELETE")) {
      const [, kind, rawId] = promptItemMatch;
      const id = decodeURIComponent(rawId);
      const result = req.method === "PUT"
        ? await promptLibrary.update(kind, id, await readRequestBody(req))
        : await promptLibrary.remove(kind, id);
      notifyClients("prompt-library-change");
      sendJson(res, { ok: true, result });
      return;
    }

    if (url.pathname === "/api/3d/status" && req.method === "GET") {
      sendJson(res, await threeDWorkbench.status());
      return;
    }

    if (url.pathname === "/api/3d/tasks" && req.method === "GET") {
      sendJson(res, {
        tasks: await threeDWorkbench.list({
          projectId: url.searchParams.get("project") || "",
          limit: url.searchParams.get("limit") || 100
        })
      });
      return;
    }

    if (url.pathname === "/api/3d/tasks" && req.method === "POST") {
      const body = await readRequestBody(req);
      const config = await loadConfig();
      const task = await threeDWorkbench.create(body, config.projects);
      notifyClients("three-d-change");
      sendJson(res, { ok: true, task });
      return;
    }

    const threeDMatch = url.pathname.match(/^\/api\/3d\/tasks\/([^/]+)\/(refresh|open)$/);
    if (threeDMatch && req.method === "POST") {
      const [, rawId, action] = threeDMatch;
      const id = decodeURIComponent(rawId);
      const { task } = await threeDWorkbench.get(id);
      const config = await loadConfig();
      const result = action === "refresh" ? await threeDWorkbench.refresh(id, config.projects) : task;
      if (action === "open") {
        const { workspacePath } = await threeDWorkbench.validatedWorkspace(task, config.projects);
        openFinder(workspacePath, false);
      }
      notifyClients("three-d-change");
      sendJson(res, { ok: true, task: result });
      return;
    }

    const threeDDeleteMatch = url.pathname.match(/^\/api\/3d\/tasks\/([^/]+)$/);
    if (threeDDeleteMatch && req.method === "DELETE") {
      const result = await threeDWorkbench.remove(decodeURIComponent(threeDDeleteMatch[1]));
      notifyClients("three-d-change");
      sendJson(res, { ok: true, result });
      return;
    }

    if (url.pathname === "/api/projects/reorder" && req.method === "POST") {
      const body = await readRequestBody(req);
      const projects = await reorderProjects(body.projectIds);
      sendJson(res, { ok: true, projects });
      return;
    }

    if (url.pathname === "/api/projects" && req.method === "POST") {
      const body = await readRequestBody(req);
      const project = await addProject(body);
      sendJson(res, { ok: true, project });
      return;
    }

    if (url.pathname === "/api/projects") {
      sendJson(res, { projects: await listProjects() });
      return;
    }

    if (url.pathname === "/api/canvas" && req.method === "GET") {
      const projectId = url.searchParams.get("project") || "";
      await getProjectStrict(projectId);
      sendJson(res, { board: canvasBoardForClient(await canvasStore.read(projectId)) });
      return;
    }

    if (url.pathname === "/api/canvas" && req.method === "PUT") {
      const projectId = url.searchParams.get("project") || "";
      await getProjectStrict(projectId);
      const board = await canvasStore.write(projectId, await readRequestBody(req));
      sendJson(res, { ok: true, board: canvasBoardForClient(board) });
      return;
    }

    if (url.pathname === "/api/folders" && req.method === "POST") {
      const folder = await addProjectFolder(await readRequestBody(req));
      sendJson(res, { ok: true, folder });
      return;
    }

    if (url.pathname === "/api/folders" && req.method === "PATCH") {
      const folder = await renameProjectDirectory(await readRequestBody(req));
      sendJson(res, { ok: true, folder });
      return;
    }

    if (url.pathname === "/api/folders") {
      const projectId = url.searchParams.get("project");
      sendJson(res, await listProjectFolders(projectId));
      return;
    }

    if (url.pathname === "/api/move-asset" && req.method === "POST") {
      const body = await readRequestBody(req);
      const result = await moveAsset(body);
      notifyClients("asset-change");
      sendJson(res, { ok: true, result });
      return;
    }

    if (url.pathname === "/api/batch-move" && req.method === "POST") {
      const result = await batchMoveAssets(await readRequestBody(req));
      if (result.results.length) notifyClients("asset-change");
      sendJson(res, { ok: result.errors.length === 0, ...result });
      return;
    }

    if (url.pathname === "/api/batch-mark" && req.method === "POST") {
      const result = await batchMarkAssets(await readRequestBody(req));
      sendJson(res, { ok: result.errors.length === 0, ...result });
      return;
    }

    if (url.pathname === "/api/trash-assets" && req.method === "POST") {
      const result = await trashAssets(await readRequestBody(req));
      notifyClients("asset-change");
      sendJson(res, { ok: true, result });
      return;
    }

    if (url.pathname === "/api/restore-trash" && req.method === "POST") {
      const result = await restoreTrashedAssets(await readRequestBody(req));
      notifyClients("asset-change");
      sendJson(res, { ok: true, result });
      return;
    }

    if (url.pathname === "/api/config") {
      sendJson(res, await loadConfig());
      return;
    }

    if (url.pathname === "/api/rhythm-control/status") {
      sendJson(res, await rhythmControlStatus(url.searchParams.get("project") || ""));
      return;
    }

    if (url.pathname === "/api/rhythm-control/create" && req.method === "POST") {
      const body = await readRequestBody(req);
      const track = await createRhythmControlTrack(body);
      notifyClients("rhythm-control-change");
      sendJson(res, { ok: true, track });
      return;
    }

    if (url.pathname === "/api/generation/status") {
      sendJson(res, await generationPipeline.status());
      return;
    }

    if (url.pathname === "/api/generation/bindings" && req.method === "GET") {
      sendJson(res, { bindings: await generationPipeline.listBindings() });
      return;
    }

    if (url.pathname === "/api/generation/bindings" && req.method === "POST") {
      const body = await readRequestBody(req);
      const binding = await generationPipeline.bindThread(body, await loadConfig());
      notifyClients("generation-change");
      sendJson(res, { ok: true, binding });
      return;
    }

    if (url.pathname === "/api/generation/bindings" && req.method === "DELETE") {
      const body = await readRequestBody(req);
      const result = await generationPipeline.unbindThread(body.threadId || url.searchParams.get("threadId") || "");
      notifyClients("generation-change");
      sendJson(res, { ok: true, result });
      return;
    }

    if (url.pathname === "/api/generation/tickets" && req.method === "GET") {
      sendJson(res, {
        tickets: await generationPipeline.list({
          limit: url.searchParams.get("limit") || 100,
          status: url.searchParams.get("status") || ""
        })
      });
      return;
    }

    if (url.pathname === "/api/generation/tickets" && req.method === "POST") {
      const body = await readRequestBody(req);
      const ticket = await generationPipeline.create(body, await loadConfig());
      notifyClients("generation-change");
      sendJson(res, { ok: true, ticket });
      return;
    }

    const generationMatch = url.pathname.match(/^\/api\/generation\/tickets\/([^/]+)\/(arm|generated|attach|cancel)$/);
    if (generationMatch && req.method === "POST") {
      const [, rawTicketId, action] = generationMatch;
      const ticketId = decodeURIComponent(rawTicketId);
      const body = await readRequestBody(req);
      const config = await loadConfig();
      let result;
      if (action === "arm") {
        result = await generationPipeline.arm(ticketId, config);
      } else if (action === "generated") {
        result = await generationPipeline.markGenerated(ticketId, body);
      } else if (action === "attach") {
        result = await generationPipeline.attach(ticketId, body, config);
      } else {
        result = await generationPipeline.cancel(ticketId, body.reason || "");
      }
      notifyClients("generation-change");
      sendJson(res, { ok: true, result });
      return;
    }

    if (url.pathname === "/api/automation/status") {
      const config = await loadConfig();
      sendJson(res, await downloadAutomation.status(config.automation, config.projects));
      return;
    }

    if (url.pathname === "/api/automation/settings" && req.method === "POST") {
      const body = await readRequestBody(req);
      const automation = await saveAutomationSettings(body);
      sendJson(res, { ok: true, automation });
      return;
    }

    if (url.pathname === "/api/automation/active-profile" && req.method === "POST") {
      const body = await readRequestBody(req);
      const { saved, result: profile } = await updateConfig((config) => {
        const selected = config.automation.routing.profiles.find((item) => item.id === body.profileId);
        if (!selected) throw new Error("当前下载项目不存在");
        config.automation.routing.activeProfileId = selected.id;
        return selected;
      });
      notifyClients("automation-change");
      sendJson(res, { ok: true, activeProfileId: profile.id, profile, automation: saved.automation });
      return;
    }

    if (url.pathname === "/api/automation/organizer/preview" && req.method === "POST") {
      const body = await readRequestBody(req);
      const config = await loadConfig();
      sendJson(res, await downloadAutomation.previewOrganizer(body.automation || config.automation, config.projects));
      return;
    }

    if (url.pathname === "/api/automation/organizer/run" && req.method === "POST") {
      const body = await readRequestBody(req);
      const config = await loadConfig();
      const result = await withAutomationLock(() => downloadAutomation.runOrganizer(body.automation || config.automation, config.projects));
      if (result.imported.length) notifyClients("automation-change");
      sendJson(res, result);
      return;
    }

    if (url.pathname === "/api/automation/cleanup/preview" && req.method === "POST") {
      const body = await readRequestBody(req);
      const config = await loadConfig();
      sendJson(res, await downloadAutomation.previewCleanup(body.automation || config.automation));
      return;
    }

    if (url.pathname === "/api/automation/cleanup/run" && req.method === "POST") {
      const body = await readRequestBody(req);
      const config = await loadConfig();
      if (!config.automation.cleanup.dryRun && body.confirm !== true) {
        throw new Error("实际清理需要再次确认");
      }
      const result = await withAutomationLock(() => downloadAutomation.runCleanup(config.automation));
      if (result.quarantined?.length || result.purged?.length) notifyClients("automation-change");
      sendJson(res, result);
      return;
    }

    if (url.pathname === "/api/toggle-enabled" && req.method === "POST") {
      const body = await readRequestBody(req);
      const enabled = Boolean(body.enabled);
      await updateConfig((config) => { config.enabled = enabled; });
      notifyClients("config-change");
      sendJson(res, { ok: true, enabled });
      return;
    }

    if (url.pathname === "/api/cases") {
      const projectId = url.searchParams.get("project");
      const project = await getProjectStrict(projectId);
      sendJson(res, { projectRoot: project.path, project, cases: await listCases(project.id) });
      return;
    }

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive"
      });
      res.write(`event: connected\n`);
      res.write(`data: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (url.pathname === "/api/assets") {
      const projectId = url.searchParams.get("project");
      const caseId = url.searchParams.get("case");
      if (!caseId) return sendJson(res, { error: "Missing case" }, 400);
      const project = await getProjectStrict(projectId);
      sendJson(res, { projectId: project.id, caseId, assets: await listAssets(project.id, caseId) });
      return;
    }

    if (url.pathname === "/api/mark" && req.method === "POST") {
      const body = await readRequestBody(req);
      const result = await markAsset(body);
      sendJson(res, { ok: true, meta: result.meta, previous: result.previous });
      return;
    }

    if (url.pathname === "/api/reveal" && req.method === "POST") {
      const body = await readRequestBody(req);
      const project = await getProjectStrict(body.projectId);
      const target = safeResolveProject(project, body.path);
      await assertRealPathContained(project.path, target);
      openFinder(target, true);
      sendJson(res, { ok: true });
      return;
    }

    if (url.pathname === "/api/open-folder" && req.method === "POST") {
      const body = await readRequestBody(req);
      const project = await getProjectStrict(body.projectId);
      const target = safeResolveProject(project, body.path);
      await assertRealPathContained(project.path, target);
      openFinder(path.dirname(target), false);
      sendJson(res, { ok: true });
      return;
    }

    if (url.pathname === "/media" || url.pathname === "/download") {
      const projectId = url.searchParams.get("project");
      const project = await getProjectStrict(projectId);
      const requested = url.searchParams.get("path");
      const filePath = safeResolveProject(project, requested);
      await assertRealPathContained(project.path, filePath);
      await serveFile(req, res, filePath, url.pathname === "/download");
      return;
    }

    let staticPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = safeResolvePublic(staticPath);
    if (!await exists(filePath)) {
      sendText(res, "Not found", 404);
      return;
    }
    await serveFile(req, res, filePath, false, (url.pathname === "/" || url.pathname === "/index.html")
      ? { "set-cookie": browserSessionCookie }
      : {});
  } catch (error) {
    sendJson(res, { error: error.message || String(error) }, Number(error.statusCode) || 500);
  }
});

async function startServer() {
  // Validate the persisted configuration before opening the local API. A
  // malformed file must never be treated as an empty configuration and later
  // overwritten by an unrelated write request.
  await loadConfig();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Generation asset workbench running at http://127.0.0.1:${port}`);
    console.log(`Config: ${configPath}`);
  });

  await ensureWatchers();
  setTimeout(runDuplicateSweep, 8000).unref();
  setInterval(runDuplicateSweep, 6 * 60 * 60 * 1000).unref();
  setTimeout(checkAutomationSchedule, 3000).unref();
  setInterval(checkAutomationSchedule, 5000).unref();
  setInterval(() => {
    for (const client of sseClients) {
      client.write(`event: ping\n`);
      client.write(`data: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    }
  }, 30000).unref();
}

startServer().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
