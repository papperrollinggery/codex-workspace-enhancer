#!/usr/bin/env node

import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function prepareOwnedProfile(stateDir) {
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir)) {
    throw new Error("Owned state directory must be absolute");
  }
  const requestedState = path.resolve(stateDir);
  const stateStats = await lstat(requestedState);
  if (!stateStats.isDirectory() || stateStats.isSymbolicLink()) {
    throw new Error("Owned state directory must be a real directory");
  }
  const realState = await realpath(requestedState);
  const profileDir = path.join(requestedState, "EnhancedProfile");
  try {
    await mkdir(profileDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const profileStats = await lstat(profileDir);
  if (!profileStats.isDirectory() || profileStats.isSymbolicLink()) {
    throw new Error("Enhanced profile must be a real directory");
  }
  const realProfile = await realpath(profileDir);
  if (path.dirname(realProfile) !== realState || path.basename(realProfile) !== "EnhancedProfile") {
    throw new Error("Enhanced profile escapes the owned state directory");
  }
  const handle = await open(profileDir, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error("Enhanced profile must remain a directory");
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
  return realProfile;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) throw new Error("Usage: prepare-owned-profile.mjs ABSOLUTE_STATE_DIR");
  const profile = await prepareOwnedProfile(argv[0]);
  process.stdout.write(`${profile}\n`);
  return profile;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
