import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ThreeDWorkbench } from "../three-d-workbench.js";

test("3D workbench rejects symlinked assets and forged external workspaces", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "three-d-safe-"));
  const project = path.join(temporary, "project");
  const outside = path.join(temporary, "outside");
  const registryPath = path.join(temporary, "registry.json");
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "reference.png"), "image", "utf8");
  await symlink(outside, path.join(project, "linked"));
  const workbench = new ThreeDWorkbench({ registryPath, skillRoot: temporary });
  workbench.skillStatus = async () => ({ ready: true, version: "test" });
  workbench.runPython = async () => ({ stdout: "{}", stderr: "", code: 0 });
  const projects = [{ id: "p", name: "Project", path: project }];
  try {
    await assert.rejects(workbench.create({
      projectId: "p",
      assetPath: path.join(project, "linked", "reference.png"),
      targetName: "unsafe",
    }, projects), /outside|resolves|project/i);

    await writeFile(registryPath, JSON.stringify({ version: 1, tasks: [{
      id: "forged",
      projectId: "p",
      workspacePath: outside,
      workspaceRelPath: "../outside",
      stages: [],
      stageIndex: 0,
    }] }), "utf8");
    await assert.rejects(workbench.refresh("forged", projects), /outside|range|越出/i);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("3D registry corruption fails closed", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "three-d-corrupt-"));
  const registryPath = path.join(temporary, "registry.json");
  await writeFile(registryPath, "{bad-json", "utf8");
  const workbench = new ThreeDWorkbench({ registryPath, skillRoot: temporary });
  try {
    await assert.rejects(workbench.read(), SyntaxError);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
