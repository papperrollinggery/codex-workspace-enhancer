import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GenerationPipeline } from "../generation-pipeline.js";

function configFor(project, inbox, { move = false } = {}) {
  return {
    projects: [{ id: "p", name: "Project", path: project, scanRoots: ["."] }],
    automation: {
      inbox: { sourcePath: inbox, transferMode: move ? "move" : "copy", moveApprovedAt: move ? new Date().toISOString() : null },
      routing: { profiles: [] },
    },
  };
}

test("generation move is limited to the armed inbox and stale owned locks recover", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "generation-safe-"));
  const project = path.join(temporary, "project");
  const inbox = path.join(temporary, "inbox");
  const outside = path.join(temporary, "outside.png");
  await mkdir(project, { recursive: true });
  await mkdir(inbox, { recursive: true });
  await writeFile(outside, "outside", "utf8");
  const pipeline = new GenerationPipeline({ registryPath: path.join(temporary, "tickets.json") });
  const config = configFor(project, inbox, { move: true });
  try {
    const ticket = await pipeline.create({ projectId: "p", kind: "image", name: "safe" }, config);
    await pipeline.arm(ticket.id, config);
    await assert.rejects(
      pipeline.attach(ticket.id, { sourcePath: outside, moveSource: true }, config),
      /approved root|收件箱|outside/i,
    );
    assert.equal(await readFile(outside, "utf8"), "outside");

    await writeFile(pipeline.lockPath, JSON.stringify({
      pid: 2_000_000_000,
      hostname: os.hostname(),
      nonce: "dead-owner",
      createdAt: new Date().toISOString(),
    }), "utf8");
    const started = Date.now();
    await pipeline.markGenerated(ticket.id, { id: "result" });
    assert.ok(Date.now() - started < 1_000, "dead local lock should recover without a five-second stall");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("generation ledger symlink and failed commit keep the source and registry intact", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "generation-ledger-"));
  const project = path.join(temporary, "project");
  const inbox = path.join(temporary, "inbox");
  const outsideLedger = path.join(temporary, "external-ledger");
  await mkdir(project, { recursive: true });
  await mkdir(inbox, { recursive: true });
  await mkdir(outsideLedger, { recursive: true });
  const source = path.join(inbox, "result.png");
  await writeFile(source, "image", "utf8");
  await symlink(outsideLedger, path.join(project, "生成记录"));
  const pipeline = new GenerationPipeline({ registryPath: path.join(temporary, "tickets.json") });
  const config = configFor(project, inbox, { move: true });
  try {
    const ticket = await pipeline.create({ projectId: "p", kind: "image", name: "rollback" }, config);
    await pipeline.arm(ticket.id, config);
    await assert.rejects(
      pipeline.attach(ticket.id, { sourcePath: source, moveSource: true }, config),
      /outside|resolves|approved root|生成记录/i,
    );
    assert.equal(await readFile(source, "utf8"), "image");
    assert.equal((await pipeline.get(ticket.id)).outputs.length, 0);
    assert.deepEqual(await (await import("node:fs/promises")).readdir(outsideLedger), []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("generation inbox comes only from config and source deletion requires explicit move approval", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "generation-inbox-approval-"));
  const project = path.join(temporary, "project");
  const inbox = path.join(temporary, "inbox");
  await mkdir(project, { recursive: true });
  await mkdir(inbox, { recursive: true });
  const source = path.join(inbox, "result.png");
  await writeFile(source, "image", "utf8");
  const pipeline = new GenerationPipeline({ registryPath: path.join(temporary, "tickets.json") });
  const copyConfig = configFor(project, inbox);
  try {
    const ticket = await pipeline.create({ projectId: "p", kind: "image", name: "approval" }, copyConfig);
    await assert.rejects(
      pipeline.arm(ticket.id, { sourcePath: inbox }),
      /收件箱.*配置|自动化设置/i,
    );
    await pipeline.arm(ticket.id, copyConfig);
    await assert.rejects(
      pipeline.attach(ticket.id, { sourcePath: source, moveSource: true }, copyConfig),
      /明确启用并确认移动模式/i,
    );
    assert.equal(await readFile(source, "utf8"), "image");

    const moveConfig = configFor(project, inbox, { move: true });
    assert.equal((await pipeline.get(ticket.id)).inboxPath, await (await import("node:fs/promises")).realpath(inbox));
    assert.equal(path.dirname(source), inbox);
    const result = await pipeline.attach(ticket.id, { sourcePath: source, moveSource: true }, moveConfig);
    await assert.rejects(readFile(source, "utf8"), /ENOENT/);
    assert.equal(result.output.movedSource, true);
    assert.equal((await pipeline.get(ticket.id)).outputs[0].movedSource, true);
    const meta = JSON.parse(await readFile(result.output.metaPath, "utf8"));
    assert.equal(meta.output.movedSource, true);
    const ledger = (await readFile(result.ledgerPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(ledger.at(-1).output.movedSource, true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("duplicate generation output preserves its source and historical move metadata", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "generation-duplicate-source-"));
  const project = path.join(temporary, "project");
  const inbox = path.join(temporary, "inbox");
  await mkdir(project, { recursive: true });
  await mkdir(inbox, { recursive: true });
  const firstSource = path.join(inbox, "first.png");
  const duplicateSource = path.join(inbox, "duplicate.png");
  await writeFile(firstSource, "same-image", "utf8");
  await writeFile(duplicateSource, "same-image", "utf8");
  const pipeline = new GenerationPipeline({ registryPath: path.join(temporary, "tickets.json") });
  const copyConfig = configFor(project, inbox);
  try {
    const ticket = await pipeline.create({ projectId: "p", kind: "image", name: "duplicate" }, copyConfig);
    await pipeline.arm(ticket.id, copyConfig);
    const first = await pipeline.attach(ticket.id, { sourcePath: firstSource, moveSource: false }, copyConfig);
    assert.equal(first.output.movedSource, false);
    const duplicate = await pipeline.attach(ticket.id, { sourcePath: duplicateSource, moveSource: true }, configFor(project, inbox, { move: true }));
    assert.equal(duplicate.duplicate, true);
    assert.match(duplicate.sourceRemovalWarning, /源文件已保留/);
    assert.equal(await readFile(duplicateSource, "utf8"), "same-image");
    assert.equal(duplicate.output.movedSource, false);
    assert.equal((await pipeline.get(ticket.id)).outputs[0].movedSource, false);
    assert.equal(JSON.parse(await readFile(first.output.metaPath, "utf8")).output.movedSource, false);
    assert.equal(JSON.parse((await readFile(first.ledgerPath, "utf8")).trim()).output.movedSource, false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
