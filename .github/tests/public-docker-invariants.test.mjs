import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

function yamlServiceBlock(text, name) {
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

function releaseGroupTargets(bake, group) {
  const match = new RegExp('group "' + group + '" \\{([\\s\\S]*?)\\n\\}').exec(bake);
  assert(match, "Bake group " + group + " not found");

  const targets = /targets\s*=\s*\[([^\]]*)\]/.exec(match[1]);
  assert(targets, "targets not found in Bake group " + group);
  return [...targets[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function targetForImage(bake, imageName) {
  const targets = /target "([^"]+)" \{([\s\S]*?)(?=\ntarget "|$)/g;
  for (const match of bake.matchAll(targets)) {
    if (match[2].includes("aztec-fpc-" + imageName + ":")) return match[1];
  }
  return null;
}

function workflowTargetGroup(workflow) {
  const match = /^\s+targets:\s+([A-Za-z0-9_-]+)\s*$/m.exec(workflow);
  assert(match, "docker/bake-action target group not found");
  return match[1];
}

function pushPaths(workflow) {
  const lines = workflow.split("\n");
  const index = lines.findIndex((line) => /^    paths:\s*$/.test(line));
  assert.notEqual(index, -1, "push.paths not found");

  const paths = [];
  for (let i = index + 1; i < lines.length; i++) {
    const match = /^      - "([^"]+)"\s*$/.exec(lines[i]);
    if (!match) break;
    paths.push(match[1]);
  }
  return paths;
}

const localCompose = read("docker-compose.yaml");
const publicCompose = read("docker-compose.public.yaml");
const bake = read("docker-bake.hcl");
const releaseWorkflow = read(".github/workflows/docker-build-services.yml");

for (const [name, compose] of [
  ["docker-compose.yaml", localCompose],
  ["docker-compose.public.yaml", publicCompose],
]) {
  test(name + ": postdeploy waits for token configuration", () => {
    const postdeploy = yamlServiceBlock(compose, "postdeploy");
    assert.match(
      postdeploy,
      /\n      configure-token:\n        condition: service_completed_successfully/,
    );
  });
}

test("every public Compose image is published by the Docker Hub release group", () => {
  const publicImages = [
    ...new Set(
      [...publicCompose.matchAll(/^\s+image:\s+nethermind\/aztec-fpc-([^:$\s]+):/gm)].map(
        (match) => match[1],
      ),
    ),
  ];
  const group = workflowTargetGroup(releaseWorkflow);
  const targets = releaseGroupTargets(bake, group);

  const missing = publicImages.filter((image) => {
    const target = targetForImage(bake, image);
    return !target || !targets.includes(target);
  });

  assert.deepEqual(missing, []);
});

test("Docker Hub publisher watches all aztec-fpc-test release inputs", () => {
  const required = [
    ".aztecrc",
    ".dockerignore",
    ".gitmodules",
    "Nargo.toml",
    "docker-bake.hcl",
    "Dockerfile.test",
    "codegen/**",
    "contract-deployment/**",
    "contracts/**",
    "examples/package.json",
    "mock/counter/**",
    "scripts/**",
    "sdk/**",
    "services/**",
    "vendor/**",
    "vitest.config.ts",
    "package.json",
    "bun.lock",
    "tsconfig*.json",
    ".github/workflows/docker-build-services.yml",
  ];

  const paths = pushPaths(releaseWorkflow);
  assert.deepEqual(required.filter((path) => !paths.includes(path)), []);
});
