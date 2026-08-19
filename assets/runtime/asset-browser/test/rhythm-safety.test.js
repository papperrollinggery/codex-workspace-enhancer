import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "rhythm-control-track.py");

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)));
  });
}

test("rhythm builder ignores caller workDir and cleans only its owned random directory", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX launcher fixture");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "rhythm-safe-"));
  const project = path.join(temporary, "project");
  const output = path.join(project, "audio");
  const workRoot = path.join(temporary, "owned-work");
  const victim = path.join(temporary, "victim");
  const fakeBin = path.join(temporary, "bin");
  const payloadPath = path.join(temporary, "payload.json");
  const resultPath = path.join(temporary, "result.json");
  const catalogPath = path.join(temporary, "catalog.json");
  await mkdir(victim, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(path.join(victim, "sentinel.txt"), "keep", "utf8");
  await writeFile(catalogPath, JSON.stringify({ entries: [] }), "utf8");
  const fakeFfmpeg = path.join(fakeBin, "ffmpeg");
  await writeFile(fakeFfmpeg, "#!/bin/sh\nfor last do :; done\nprintf audio > \"$last\"\n", "utf8");
  await chmod(fakeFfmpeg, 0o755);
  await writeFile(payloadPath, JSON.stringify({
    projectRoot: project,
    projectId: "p",
    projectName: "Project",
    outputDir: output,
    name: "control",
    duration: 2,
    mode: "sfx",
    cues: [],
    workRoot,
    workDir: victim,
    sfxCatalog: catalogPath,
    audioSkillRoot: temporary,
    aceStepLauncher: path.join(temporary, "unused"),
    musicGeneratorScript: path.join(temporary, "unused.py"),
  }), "utf8");
  try {
    await run("python3", [scriptPath, "--payload", payloadPath, "--result", resultPath], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH || ""}` },
      stdio: ["ignore", "ignore", "pipe"],
    });
    assert.equal(await readFile(path.join(victim, "sentinel.txt"), "utf8"), "keep");
    assert.equal((await readdir(workRoot)).length, 0);
    assert.equal(JSON.parse(await readFile(resultPath, "utf8")).ok, true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
