import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claim, release } from "../lib/jobs";
import { releaseStuck } from "../lib/pipeline";
import { saveProject } from "../lib/store";
import type { Project } from "../lib/types";

function project(id: string, fileName: string, duration: number): Project {
  return {
    id,
    title: id,
    source: "url",
    sourceLabel: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    fileName,
    duration,
    status: "analyzing",
    error: null,
    progress: 15,
    stage: "Fetching the source",
    createdAt: new Date().toISOString(),
    transcript: null,
    warning: null,
  };
}

test("stale recovery removes an unfinished fetch and keeps a real master", async () => {
  const previous = process.env.DATA_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-recover-"));
  process.env.DATA_DIR = root;
  process.env.KEEL_MAX_JOBS = "8";
  const masters = path.join(root, "masters");
  fs.mkdirSync(masters, { recursive: true });
  const done = path.join(masters, "prj_done.mp4");
  const partial = path.join(masters, "prj_partial.mp4");
  const neighbor = path.join(masters, "prj_partial_extra.mp4");
  fs.writeFileSync(done, "valid-master");
  fs.writeFileSync(`${done}.part`, "orphan");
  fs.writeFileSync(path.join(masters, "prj_done.f137.mp4"), "fragment");
  fs.writeFileSync(partial, "unfinished");
  fs.writeFileSync(`${partial}.part`, "unfinished-part");
  fs.writeFileSync(neighbor, "do-not-touch");
  saveProject(project("prj_done", "prj_done.mp4", 12));
  saveProject(project("prj_partial", "prj_partial.mp4", 0));

  assert.equal(claim("prj_done"), true);
  try {
    assert.equal(releaseStuck("prj_done"), false);
    assert.equal(fs.readFileSync(done, "utf8"), "valid-master");
  } finally {
    release("prj_done");
  }

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.mkdirSync(path.join(root, "locks"), { recursive: true });
  fs.writeFileSync(path.join(root, "locks", "prj_partial.json"), JSON.stringify({ pid: child.pid, at: Date.now() }));
  try {
    assert.equal(releaseStuck("prj_partial"), false);
    assert.equal(fs.existsSync(partial), true);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }

  fs.writeFileSync(path.join(root, "locks", "prj_partial.json"), JSON.stringify({ pid: 2147483646, at: Date.now() }));
  assert.equal(releaseStuck("prj_partial"), true);
  assert.equal(fs.existsSync(partial), false);
  assert.equal(fs.existsSync(`${partial}.part`), false);
  assert.equal(fs.readFileSync(neighbor, "utf8"), "do-not-touch");

  assert.equal(releaseStuck("prj_done"), true);
  assert.equal(fs.readFileSync(done, "utf8"), "valid-master");
  assert.equal(fs.existsSync(`${done}.part`), false);
  assert.equal(fs.existsSync(path.join(masters, "prj_done.f137.mp4")), false);

  if (previous === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
