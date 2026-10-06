import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const REPO = process.env.FPC_REPO ?? process.cwd();
const read = (p) => readFileSync(path.join(REPO, p), "utf8");
const tracked = execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" }).trim().split("\n").filter(Boolean);

const INPUT_STAGES = [
  { file: "Dockerfile.test" },
  { file: "services/Dockerfile.common", stages: new Set(["base", "deps"]) },
  { file: "scripts/contract/Dockerfile.contract" },
];
const DEFINITION_FILES = [
  ".dockerignore",
  "docker-bake.hcl",
  "Dockerfile.test",
  "services/Dockerfile.common",
  "scripts/contract/Dockerfile.deploy",
  "scripts/contract/Dockerfile.contract",
];

function copySources(dockerfile, allowedStages) {
  const out = [];
  let stage = "";
  for (const raw of read(dockerfile).split("\n")) {
    const line = raw.trim();
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) { stage = from[1] ?? ""; continue; }
    if (allowedStages && !allowedStages.has(stage)) continue;
    if (!/^COPY\s/i.test(line) || /--from=/.test(line)) continue;
    const tokens = line.split(/\s+/).slice(1).filter((t) => !t.startsWith("--"));
    for (const src of tokens.slice(0, -1)) {
      if (src.includes("${")) throw new Error(`unexpanded variable in ${dockerfile}: ${line}`);
      out.push(src.replace(/\/$/, ""));
    }
  }
  return out;
}

function imageInputFiles() {
  const files = new Set();
  for (const { file, stages } of INPUT_STAGES) {
    for (const src of copySources(file, stages)) {
      for (const f of tracked) if (f === src || f.startsWith(`${src}/`)) files.add(f);
    }
  }
  for (const f of DEFINITION_FILES) if (tracked.includes(f)) files.add(f);
  return [...files].sort();
}

function extractPushPaths(text) {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => /^\s{4}paths:\s*$/.test(l));
  assert.notEqual(i, -1, "push.paths not found");
  const out = [];
  for (let n = i + 1; n < lines.length; n++) {
    const m = /^\s{6}-\s+["']([^"']+)["']\s*$/.exec(lines[n]);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

function extractPrPaths(text) {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => /^\s{12}relevant:\s*$/.test(l));
  assert.notEqual(i, -1, "dorny relevant filter not found");
  const out = [];
  for (let n = i + 1; n < lines.length; n++) {
    const m = /^\s{14}-\s+["']([^"']+)["']\s*$/.exec(lines[n]);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

function globRegex(pattern) {
  // Deliberately support only syntax used by this workflow. Fail closed if it grows.
  if (/[[\]{}!?+@]/.test(pattern)) throw new Error(`unsupported workflow glob syntax: ${pattern}`);
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") { out += ".*"; i++; }
    else if (c === "*") out += "[^/]*";
    else out += c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(out + "$");
}

function uncovered(patterns) {
  const matchers = patterns.map(globRegex);
  return imageInputFiles().filter((f) => !matchers.some((m) => m.test(f)));
}

const workflow = read(".github/workflows/docker-build-ci.yml");
const pushPaths = extractPushPaths(workflow);
const prPaths = extractPrPaths(workflow);

test("harness discovers representative image inputs", () => {
  const files = imageInputFiles();
  assert(files.includes(".dockerignore"));
  assert(files.includes("contract-deployment/src/index.ts"));
  assert(files.includes("sdk/src/payment-method.ts"));
  assert(files.includes("codegen/FPCMultiAsset.ts"));
  assert(files.includes("vendor/aztec-standards"));
});

test("push.paths and pull-request relevant filters stay identical", () => {
  assert.deepEqual(prPaths, pushPaths);
});

test("every aztec-fpc-test build input triggers push build/publish", () => {
  assert.deepEqual(uncovered(pushPaths), []);
});

test("every aztec-fpc-test build input triggers PR Docker build/e2e", () => {
  assert.deepEqual(uncovered(prPaths), []);
});
