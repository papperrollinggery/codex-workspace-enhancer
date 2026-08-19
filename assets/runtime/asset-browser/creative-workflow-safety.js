import path from "node:path";
import { isPathInside } from "./platform-compat.js";

const PROTECTED_EXACT = new Set([
  "finaldelivery",
  "finaloutput",
  "成片",
  "最终输出",
  "生成记录",
  "参考库",
  "referencelibrary",
  "aireferencelibrary"
]);

function policyKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_.\-/\\]+/g, "");
}

function protectedSegmentReason(segment) {
  const key = policyKey(segment);
  if (PROTECTED_EXACT.has(key) || key.startsWith("finaldelivery") || key.startsWith("finaloutput")
    || key.startsWith("referencelibrary") || key.startsWith("aireferencelibrary")) return `受保护目录：${segment}`;
  if (key.includes("成片") || key.includes("最终输出") || key.includes("生成记录") || key.includes("参考库")) return `受保护目录：${segment}`;
  return "";
}

function localDateKeys(date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return new Set([`${year}${month}${day}`, `${year}${Number(month)}${Number(day)}`]);
}

function isDailyPractice(value) {
  const key = policyKey(value);
  return key.includes("每日练习") || key.includes("dailypractice");
}

function containsToday(value, today) {
  const digits = String(value || "").replace(/\D/g, "");
  return [...localDateKeys(today)].some((key) => digits.includes(key));
}

export function protectedCreativePathReason(targetPath, {
  projectRoot = "",
  project = null,
  today = new Date()
} = {}) {
  const absoluteTarget = path.resolve(String(targetPath || ""));
  const absoluteRoot = projectRoot ? path.resolve(String(projectRoot)) : "";
  if (!targetPath || (absoluteRoot && !isPathInside(absoluteRoot, absoluteTarget))) {
    return "路径不在已确认的项目范围内";
  }

  const projectLabels = [project?.id, project?.name].filter(Boolean);
  for (const label of projectLabels) {
    const reason = protectedSegmentReason(label);
    if (reason) return reason;
  }

  const relative = absoluteRoot ? path.relative(absoluteRoot, absoluteTarget) : absoluteTarget;
  const segments = relative.split(path.sep).filter(Boolean);
  for (const segment of segments) {
    const reason = protectedSegmentReason(segment);
    if (reason) return reason;
  }

  const dailyContext = projectLabels.some(isDailyPractice) || segments.some(isDailyPractice);
  if (dailyContext && [...projectLabels, ...segments].some((segment) => containsToday(segment, today))) {
    return "每日练习当天目录受保护";
  }
  return "";
}

export function isProtectedCreativePath(targetPath, options = {}) {
  return Boolean(protectedCreativePathReason(targetPath, options));
}

export function assertAutomaticPathAllowed(targetPath, options = {}) {
  const reason = protectedCreativePathReason(targetPath, options);
  if (reason) throw new Error(`自动整理/清理已停止：${reason}`);
  return path.resolve(targetPath);
}
