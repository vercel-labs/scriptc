/** Exercise the packed npm command and its bundled host assets in isolation. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareNativeCommand } from "../packages/cli/scripts/prepare-native.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = resolve(process.argv[2]);
const identity = JSON.parse(readFileSync(join(platform, "package.json"), "utf8"));
const root = mkdtempSync(
  join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-npm-smoke-"),
);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const env = {
  ...process.env,
  npm_config_cache: join(root, "npm-cache"),
  npm_config_update_notifier: "false",
  NODE_PATH: "",
};
function command(executable, args, cwd, environment = env) {
  return execFileSync(executable, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    shell: process.platform === "win32" && executable.endsWith(".cmd"),
    maxBuffer: 16 * 1024 * 1024,
  });
}
function pack(directory) {
  const result = JSON.parse(
    command(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", root], directory),
  );
  return join(root, result[0].filename);
}
function bytes(directory) {
  let size = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    size += entry.isDirectory() ? bytes(path) : statSync(path).size;
  }
  return size;
}
try {
  // A platform package depends on its LLVM helper and runtime pack packages.
  // Pack them from this checkout, and pack the platform package with the
  // exact versions pnpm would publish for its workspace dependencies.
  const dependencies = Object.keys(identity.dependencies ?? {});
  let packed = platform;
  if (dependencies.length > 0) {
    packed = join(root, "platform");
    mkdirSync(packed);
    cpSync(join(platform, "dist"), join(packed, "dist"), { recursive: true });
    writeFileSync(
      join(packed, "package.json"),
      JSON.stringify({
        ...identity,
        dependencies: Object.fromEntries(dependencies.map((name) => [name, identity.version])),
      }),
    );
  }
  const platformTarball = pack(packed);
  const dependencyTarballs = dependencies.map((name) =>
    pack(join(repository, "packages", name.replace("@scriptc/", ""))),
  );
  const wrapper = join(root, "wrapper");
  mkdirSync(wrapper);
  cpSync(join(repository, "packages/cli/scripts"), join(wrapper, "scripts"), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(repository, "packages/cli/package.json"), "utf8"));
  assert.equal(manifest.version, identity.version);
  assert.ok(
    Object.keys(manifest.optionalDependencies).every((name) => name.startsWith("@scriptc/cli-")),
    "the default CLI must only depend on native host packages",
  );
  manifest.optionalDependencies = Object.fromEntries(
    Object.keys(manifest.optionalDependencies).map((name) => [
      name,
      name === identity.name ? "file:" + platformTarball : identity.version,
    ]),
  );
  delete manifest.devDependencies;
  delete manifest.scripts.prepack;
  writeFileSync(join(wrapper, "package.json"), JSON.stringify(manifest));
  prepareNativeCommand(wrapper);
  const tarball = pack(wrapper);
  const project = join(root, "project");
  mkdirSync(project);
  command(
    npm,
    ["install", "--offline", "--no-audit", "--no-fund", tarball, ...dependencyTarballs],
    project,
  );
  const executable = join(project, "node_modules/scriptc/bin/scriptc.exe");
  assert.equal(
    command(executable, ["--version"], project, { ...env, PATH: "" }).trim(),
    identity.version,
  );
  const entry = join(project, "hello.ts");
  writeFileSync(entry, 'console.log("Hello, world!");\n');
  const binary = join(project, process.platform === "win32" ? "hello.exe" : "hello");
  const compileEnv = { ...env, SCRIPTC_CACHE_DIR: join(root, "build-cache") };
  command(executable, ["build", entry, "-o", binary], project, compileEnv);
  const result = spawnSync(binary, [], { cwd: project, env: { PATH: "" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Hello, world!\n");
  assert.equal(result.stderr, "");
  const helloBytes = statSync(binary).size;
  writeFileSync(
    entry,
    'import { randomBytes, randomUUID } from "node:crypto";\nconst bytes = randomBytes(32);\nconsole.log(bytes.length === 32, randomUUID().length === 36, Math.random() >= 0);\n',
  );
  command(executable, ["build", entry, "-o", binary], project, compileEnv);
  assert.equal(command(binary, [], project, { PATH: "" }), "true true true\n");
  const installed = readdirSync(join(project, "node_modules/@scriptc")).sort();
  assert.deepEqual(
    installed,
    [identity.name, ...dependencies].map((name) => name.slice("@scriptc/".length)).sort(),
  );
  console.log(
    JSON.stringify({
      package: identity.name,
      version: identity.version,
      installed_packages: ["scriptc", ...installed],
      installed_file_bytes: bytes(join(project, "node_modules")),
      hello_executable_bytes: helloBytes,
      crypto_executable_bytes: statSync(binary).size,
      output: result.stdout,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
