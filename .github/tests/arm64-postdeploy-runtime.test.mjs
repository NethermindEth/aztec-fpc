import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

function serviceBlock(text, name) {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line === "  " + name + ":");
  assert.notEqual(index, -1, "service " + name + " not found");
  const block = [lines[index]];
  for (let i = index + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block.join("\n");
}

const dockerfile = read("Dockerfile.test");
const arm64Runtime = read("services/ARM64_RUNTIME.md");

test("ARM64 test image keeps the Node.js proving workaround", () => {
  assert.match(dockerfile, /FROM test-base AS test-arm64[\s\S]*ENTRYPOINT \["node", "node_modules\/\.bin\/vitest"/);
  assert.match(arm64Runtime, /unresolved NAPI crash on ARM64/);
  assert.match(arm64Runtime, /ClientIVC\s+proof generation/);
});

for (const composePath of ["docker-compose.yaml", "docker-compose.public.yaml"]) {
  test(composePath + ": postdeploy does not force Bun on ARM64", () => {
    const postdeploy = serviceBlock(read(composePath), "postdeploy");
    assert.doesNotMatch(postdeploy, /entrypoint:\s*\["bun"/);
    assert.match(postdeploy, /entrypoint:\s*\["sh", "scripts\/common\/run-ts-runtime\.sh"\]/);
  });
}

test("platform-aware TS runner uses Node on ARM64 and Bun elsewhere", () => {
  const runner = "scripts/common/run-ts-runtime.sh";
  assert.equal(existsSync(runner), true, runner + " is missing");
  const content = read(runner);
  assert.match(content, /aarch64\|arm64/);
  assert.match(content, /exec node node_modules\/\.bin\/tsx/);
  assert.match(content, /exec bun run --sequential/);
});
