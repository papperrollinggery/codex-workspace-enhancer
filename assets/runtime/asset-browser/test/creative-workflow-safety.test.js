import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  assertAutomaticPathAllowed,
  isProtectedCreativePath,
  protectedCreativePathReason
} from "../creative-workflow-safety.js";

const projectRoot = path.resolve("/tmp/creative-project");
const today = new Date(2026, 7, 15, 12, 0, 0);

test("final, output, records and reference-library areas are protected", () => {
  for (const segment of ["FinalDelivery", "Final Output v2", "成片_v3", "最终输出", "生成记录", "参考库_精选"]) {
    assert.equal(isProtectedCreativePath(path.join(projectRoot, segment, "asset.png"), { projectRoot, today }), true, segment);
  }
});

test("reference-library projects stay protected even with an unrelated folder name", () => {
  assert.match(protectedCreativePathReason(path.join(projectRoot, "incoming"), {
    projectRoot,
    project: { id: "ai-reference-library", name: "灵感精选" },
    today
  }), /受保护目录/);
});

test("only today's daily-practice directory is automatically protected", () => {
  const project = { id: "daily-practice", name: "每日练习" };
  assert.equal(isProtectedCreativePath(path.join(projectRoot, "2026-08-15", "frame.png"), { projectRoot, project, today }), true);
  assert.equal(isProtectedCreativePath(path.join(projectRoot, "2026-08-14", "frame.png"), { projectRoot, project, today }), false);
});

test("ordinary inbox routes remain available and outside-project paths fail closed", () => {
  assert.equal(assertAutomaticPathAllowed(path.join(projectRoot, "assets", "inbox"), { projectRoot }), path.join(projectRoot, "assets", "inbox"));
  assert.throws(() => assertAutomaticPathAllowed("/tmp/elsewhere", { projectRoot }), /已停止/);
});
