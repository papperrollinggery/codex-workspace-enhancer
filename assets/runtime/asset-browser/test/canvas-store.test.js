import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CanvasStore } from "../canvas-store.js";

test("canvas state is atomic, revisioned, and project-scoped", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "asset-canvas-"));
  const project = path.join(temporary, "project");
  const root = path.join(temporary, "state", "canvas");
  const image = path.join(project, "refs", "look.png");
  await mkdir(path.dirname(image), { recursive: true });
  await writeFile(image, "image", "utf8");
  const validated = [];
  const store = new CanvasStore({
    root,
    validateAsset: async (projectId, relPath) => {
      validated.push([projectId, relPath]);
      assert.equal(await readFile(path.join(project, relPath), "utf8"), "image");
    },
  });
  try {
    const empty = await store.read("project-a");
    assert.equal(empty.rev, 0);
    assert.deepEqual(empty.nodes, []);

    const saved = await store.write("project-a", {
      baseRev: 0,
      viewport: { x: 80, y: -25, scale: 1.5 },
      nodes: [{
        id: "asset-1",
        kind: "asset",
        x: 100,
        y: 200,
        width: 360,
        height: 260,
        ref: { relPath: "refs/look.png", label: "Look reference" },
      }],
    });
    assert.equal(saved.rev, 1);
    assert.deepEqual(validated, [["project-a", path.join("refs", "look.png")]]);
    assert.equal((await store.read("project-a")).nodes[0].ref.label, "Look reference");
    await assert.rejects(
      store.write("project-a", { baseRev: 0, nodes: [] }),
      (error) => error.statusCode === 409,
    );
    assert.equal((await store.read("project-b")).rev, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("canvas rejects traversal, non-images, duplicates, and corrupt persisted state", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "asset-canvas-invalid-"));
  const store = new CanvasStore({ root: path.join(temporary, "canvas"), validateAsset: async () => {} });
  try {
    await assert.rejects(store.write("p", {
      baseRev: 0,
      nodes: [{ id: "a", kind: "asset", ref: { relPath: "../escape.png" } }],
    }), /escapes/);
    await assert.rejects(store.write("p", {
      baseRev: 0,
      nodes: [{ id: "a", kind: "asset", ref: { relPath: "reference.txt" } }],
    }), /image assets only/);
    await assert.rejects(store.write("p", {
      baseRev: 0,
      nodes: [
        { id: "same", kind: "note", text: "one" },
        { id: "same", kind: "note", text: "two" },
      ],
    }), /unique/);
    await store.ensureRoot();
    await writeFile(store.boardPath("broken"), "{bad-json", "utf8");
    await assert.rejects(store.read("broken"), /left untouched/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
