#!/usr/bin/env node
/* Runs one Linux CI lane from its turbo task.
 *
 * Each task in turbo.json names a lane here (ci:lane:<name>) or a build the
 * lanes share (ci:setup:<name>). The commands are the steps of the matching
 * job in .github/workflows/ci.yml, with the steps GitHub Actions performs
 * around them replaced: checkout and pnpm install are Vercel CI's own
 * bootstrapping install, the native package artifacts are the ci:setup:native
 * tasks whose outputs turbo restores, and the LLVM, Zig, CMake and Ninja
 * toolchain is the ci:setup:toolchain task's output. The effect lane splits
 * as the workflow does: a pull request runs the one sampled shard per flavor,
 * a push to the default branch every shard.
 *
 * Usage: node scripts/ci-vercel/run-lane.mjs <lane> [arguments]
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const toolchain = join(root, ".ci/toolchain");
const libnodeDirectory = join(root, ".ci/libnode");
const baseEnv = {
  ...process.env,
  PATH: [
    join(toolchain, "llvm-22.1.8/bin"),
    join(toolchain, "zig"),
    join(toolchain, "cmake/bin"),
    join(toolchain, "ninja"),
    process.env.PATH,
  ].join(":"),
  LLVM_DIR: join(toolchain, "llvm-22.1.8/lib/cmake/llvm"),
  // The static LLVM helper links -lz and -lzstd; the toolchain task puts their static archives and headers here.
  LIBRARY_PATH: [join(toolchain, "sysroot/lib"), process.env.LIBRARY_PATH]
    .filter(Boolean)
    .join(":"),
  CPATH: [join(toolchain, "sysroot/include"), process.env.CPATH].filter(Boolean).join(":"),
};

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...baseEnv, ...env },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
}

function output(command, args, env = {}) {
  return execFileSync(command, args, {
    cwd: root,
    env: { ...baseEnv, ...env },
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
}

function pnpm(args, env = {}) {
  run("pnpm", args, env);
}

/** Runs a POSIX shell step, for the limits a lane sets around its process. */
function sh(script, env = {}) {
  run("/bin/sh", ["-c", script], env);
}

function integer(text, name) {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** The ELF object contract `file` states in the workflow: relocatable, x86-64. */
function assertElfObject(path) {
  const header = readFileSync(path).subarray(0, 20);
  const elf = header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46;
  const relocatable = header.readUInt16LE(16) === 1;
  const x86_64 = header.readUInt16LE(18) === 62;
  if (!elf || !relocatable || !x86_64)
    throw new Error(`${path} is not an ELF 64-bit LSB relocatable x86-64 object`);
}

/** The static musl helper must not name an interpreter. */
function assertNoInterpreter(path) {
  const headers = output("readelf", ["-l", path]);
  if (headers.includes("INTERP")) throw new Error(`${path} must be a static executable`);
}

/** The first `count` CPUs this container may run on, for taskset. */
function firstCpus(count) {
  const match = readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s*(.+)$/m);
  const cpus = [];
  for (const part of match?.[1]?.split(",") ?? []) {
    const [start, end] = part.split("-").map(Number);
    for (let cpu = start; cpu <= (end ?? start); cpu++) cpus.push(cpu);
  }
  return cpus.slice(0, count);
}

/** Removes setup outputs before rebuilding them. A checkout may carry files under an ignored path (git does not
 * refuse a forced add), so a build starts from empty outputs and caches only what this run creates. */
function clearOutputs(...paths) {
  for (const path of paths) rmSync(path, { recursive: true, force: true });
}

/** Removes one setup output before rebuilding it and returns it. */
function fresh(directory) {
  clearOutputs(directory);
  return directory;
}

/** "pr" for a push to a pull request's branch, "main" for the default branch, "unknown" otherwise. */
function pushMode() {
  if ((process.env.VERCEL_GIT_PULL_REQUEST_ID ?? "") !== "") return "pr";
  const ref = (process.env.VERCEL_GIT_COMMIT_REF ?? process.env.GITHUB_HEAD_REF ?? "").replace(
    /^refs\/heads\//,
    "",
  );
  if (ref !== "") return ref === "main" ? "main" : "pr";
  try {
    const head = output("git", ["rev-parse", "HEAD"]).trim();
    const main = output("git", ["rev-parse", "origin/main"]).trim();
    return head === main ? "main" : "pr";
  } catch {
    return "unknown";
  }
}

/** The one effect shard a pull request runs, as scripts/ci-lanes.mjs picks it from the pull request's number. */
function effectSampleShard() {
  const number = Number(process.env.VERCEL_GIT_PULL_REQUEST_ID);
  if (Number.isSafeInteger(number) && number > 0) return (number % 16) + 1;
  let seed = process.env.VERCEL_GIT_COMMIT_REF ?? process.env.GITHUB_HEAD_REF ?? "";
  if (seed === "") {
    try {
      seed = output("git", ["rev-parse", "HEAD"]).trim();
    } catch {
      seed = "1";
    }
  }
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return (hash % 16) + 1;
}

const frontendSuites = {
  programs: "tests/harness/self-hosting-native-frontend-programs.test.ts",
  checks: "tests/harness/self-hosting-native-frontend-checks.test.ts",
  frontend: "tests/harness/self-hosting-native-frontend.test.ts",
};

const [lane, ...args] = process.argv.slice(2);

switch (lane) {
  // Shared builds. Their outputs are what the Actions jobs download as
  // artifacts, restored here from turbo's cache.
  case "build": {
    clearOutputs(join(root, "node_modules/.cache/scriptc-tsc"));
    for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true }))
      if (entry.isDirectory()) clearOutputs(join(root, "packages", entry.name, "dist"));
    pnpm(["build"]);
    break;
  }
  case "native": {
    clearOutputs(
      join(root, "packages/llvm-linux-x64-gnu/bin"),
      join(root, "packages/runtime-linux-x64-gnu/artifacts"),
      join(root, "packages/runtime-linux-x64-gnu/runtime-pack.json"),
      join(root, "packages/runtime-linux-x64-gnu/runtime-pack.verified.json"),
    );
    pnpm(["--filter", "@scriptc/llvm-linux-x64-gnu", "build:native"]);
    pnpm(["--filter", "@scriptc/runtime-linux-x64-gnu", "build:native"], { CC: "zig", AR: "zig" });
    run(process.execPath, ["packages/runtime-linux-x64-gnu/scripts/verify.mjs"]);
    break;
  }
  case "native:musl": {
    clearOutputs(
      join(root, "packages/llvm-linux-x64-musl/bin"),
      join(root, "packages/runtime-linux-x64-musl/artifacts"),
      join(root, "packages/runtime-linux-x64-musl/runtime-pack.json"),
      join(root, "packages/runtime-linux-x64-musl/runtime-pack.verified.json"),
    );
    pnpm(["--filter", "@scriptc/llvm-linux-x64-musl", "build:native"]);
    pnpm(["--filter", "@scriptc/runtime-linux-x64-musl", "build:native"], { CC: "zig", AR: "zig" });
    run(process.execPath, ["packages/runtime-linux-x64-musl/scripts/verify.mjs"]);
    break;
  }
  case "native:wasi": {
    clearOutputs(
      join(root, "packages/runtime-wasm32-wasi/artifacts"),
      join(root, "packages/runtime-wasm32-wasi/runtime-pack.json"),
      join(root, "packages/runtime-wasm32-wasi/runtime-pack.verified.json"),
    );
    pnpm(["--filter", "@scriptc/runtime-wasm32-wasi", "build:native"], { CC: "zig", AR: "zig" });
    run(process.execPath, ["packages/runtime-wasm32-wasi/scripts/verify.mjs"]);
    break;
  }
  case "libnode": {
    run(process.execPath, [
      "packages/libnode-common/fetch-dev-pack.mjs",
      "--out",
      fresh(libnodeDirectory),
    ]);
    break;
  }

  // code_quality: lint and format, the TypeScript build (ci:setup:build),
  // the code quality and CI policy contracts, and the generated-file checks.
  case "code-quality": {
    const env = { SCRIPTC_TEST_WORKERS: "1" };
    pnpm(["format:check"]);
    pnpm(["lint"]);
    pnpm(
      [
        "test",
        "tests/harness/code-quality.test.ts",
        "tests/harness/ci-stack-scope.test.ts",
        "tests/harness/ci-preflight.test.ts",
      ],
      env,
    );
    pnpm(["generate:ts7-ast", "--check"]);
    pnpm(["generate:ir-fields", "--check"]);
    pnpm(["generate:ir-codec", "--check"]);
    break;
  }

  // coverage: the coverage report snapshots and fixtures, once per run.
  case "coverage": {
    pnpm(["test", "tests/harness/coverage.test.ts"], { SCRIPTC_TEST_WORKERS: "1" });
    break;
  }

  // ts7_parity: the TypeScript 7 full parity sweep.
  case "ts7-parity": {
    pnpm(["test:ts7"]);
    break;
  }

  // checker_identity: every corpus program compiles to the same IR and
  // diagnostics with tsgo and with tsc-ts.
  case "checker-identity": {
    const optimization = args[0];
    if (optimization !== "release" && optimization !== "dev")
      throw new Error("checker-identity needs release or dev");
    pnpm(["test:checker-identity", "--optimization", optimization]);
    break;
  }

  // linux_host_clang: a real host-clang/glibc build, never a cached binary.
  case "linux-host-clang": {
    pnpm(
      [
        "test",
        "packages/compiler/test/cc-driver.test.ts",
        "packages/compiler/src/native/sanitizer.test.ts",
        "--testNamePattern",
        "host-native clang static build|sanitized vendor archives",
      ],
      { SCRIPTC_NO_CACHE: "1" },
    );
    break;
  }

  // tests: the corpus and integration suites, split into case shards. Plain
  // runs twenty slices, sanitized thirty (scripts/ci-test.mjs).
  case "test": {
    const [flavor, shardText, countText] = args;
    if (flavor !== "plain" && flavor !== "san") throw new Error("test needs plain or san");
    const count = integer(countText, "shard count");
    const shard = integer(shardText, "shard");
    if (shard > count) throw new Error(`shard ${shard} is outside 1..${count}`);
    if (flavor === "plain" && count !== 20) throw new Error("plain tests run twenty shards");
    if (flavor === "san" && count !== 30) throw new Error("sanitized tests run thirty shards");
    sh("ulimit -c 0; exec node scripts/ci-test.mjs", {
      SCRIPTC_TEST_WORKERS: "4",
      SCRIPTC_TEST_SHARD: `${shard}/${count}`,
      SCRIPTC_SAN: flavor === "san" ? "1" : "",
      SCRIPTC_LIBNODE: libnodeDirectory,
      ASAN_OPTIONS: "detect_leaks=0",
      NODE_OPTIONS: "--max-old-space-size=4096",
    });
    break;
  }

  // effects: the Effect suites, one compiler at a time so its heap and LLVM
  // fit, in sixteen shards per flavor. A pull request runs the one shard per
  // flavor that scripts/ci-lanes.mjs samples, as the workflow does; a push to
  // the default branch runs all of them.
  case "effects": {
    const [flavor, shardText, countText] = args;
    if (flavor !== "plain" && flavor !== "san") throw new Error("effects needs plain or san");
    const count = integer(countText, "shard count");
    const shard = integer(shardText, "shard");
    if (shard > count) throw new Error(`shard ${shard} is outside 1..${count}`);
    if (pushMode() === "pr") {
      console.log(
        `A pull request runs one effect shard per flavor (ci:lane:effects:${flavor}:sample)`,
      );
      break;
    }
    pnpm(["test", "tests/harness/effect.test.ts", "tests/harness/effect4.test.ts"], {
      SCRIPTC_TEST_WORKERS: "1",
      SCRIPTC_EFFECT_TEST_CONCURRENCY: "1",
      SCRIPTC_TEST_SHARD: `${shard}/${count}`,
      SCRIPTC_SAN: flavor === "san" ? "1" : "",
      ASAN_OPTIONS: "detect_leaks=0",
    });
    break;
  }

  // effects-sample: the one shard per flavor a pull request runs.
  case "effects-sample": {
    const flavor = args[0];
    if (flavor !== "plain" && flavor !== "san")
      throw new Error("effects-sample needs plain or san");
    if (pushMode() !== "pr") {
      console.log(
        "Every effect shard runs outside a pull request (ci:lane:effects:<flavor>:<shard>)",
      );
      break;
    }
    const shard = effectSampleShard();
    console.log(`Running effect shard ${shard}/16 for ${flavor}`);
    pnpm(["test", "tests/harness/effect.test.ts", "tests/harness/effect4.test.ts"], {
      SCRIPTC_TEST_WORKERS: "1",
      SCRIPTC_EFFECT_TEST_CONCURRENCY: "1",
      SCRIPTC_TEST_SHARD: `${shard}/16`,
      SCRIPTC_SAN: flavor === "san" ? "1" : "",
      ASAN_OPTIONS: "detect_leaks=0",
    });
    break;
  }

  // island_conformance: every package program under Node, as its default
  // build, and with each package forced into a Node island, in four shards.
  case "islands": {
    const count = integer(args[1], "shard count");
    const shard = integer(args[0], "shard");
    if (shard > count) throw new Error(`shard ${shard} is outside 1..${count}`);
    pnpm(["test", "tests/harness/island-conformance.test.ts"], {
      SCRIPTC_ISLAND_CONFORMANCE: "1",
      SCRIPTC_TEST_WORKERS: "1",
      SCRIPTC_TEST_SHARD: `${shard}/${count}`,
      SCRIPTC_LIBNODE: libnodeDirectory,
    });
    break;
  }

  // three_nodes_san: the sanitized three.js nodes build alone.
  case "three-nodes-san": {
    pnpm(
      [
        "test",
        "tests/harness/three.test.ts",
        "-t",
        "'nodes' runs statically through LLVM on 'native'",
      ],
      {
        SCRIPTC_SAN: "1",
        ASAN_OPTIONS: "detect_leaks=1",
        LSAN_OPTIONS: `suppressions=${join(root, "tests/harness/lsan.supp")}:print_suppressions=0`,
      },
    );
    break;
  }

  // native_frontend_san: one sanitized self-hosting file per task, on two
  // CPUs, so the clang build of the frontend stays inside the task's memory.
  case "native-frontend-san": {
    const file = frontendSuites[args[0]];
    if (file === undefined)
      throw new Error(`native-frontend-san needs one of ${Object.keys(frontendSuites).join(", ")}`);
    const env = {
      SCRIPTC_SAN: "1",
      SCRIPTC_TEST_WORKERS: "1",
      ASAN_OPTIONS: "detect_leaks=0",
    };
    const cpus = firstCpus(2);
    if (cpus.length === 2)
      run("taskset", ["--cpu-list", cpus.join(","), "pnpm", "test", file], env);
    else pnpm(["test", file], env);
    break;
  }

  // bootstrap_seed: one instrumented seed per flavor, kept in the repository
  // directory so the bootstrap tasks below restore it from turbo's cache.
  case "bootstrap-seed": {
    const flavor = args[0];
    if (flavor !== "plain" && flavor !== "san")
      throw new Error("bootstrap-seed needs plain or san");
    const seedDirectory = fresh(join(root, ".ci/bootstrap-seed", flavor));
    run(process.execPath, ["scripts/bootstrap-seed.mjs"], {
      SCRIPTC_SAN: flavor === "san" ? "1" : "",
      SCRIPTC_BOOTSTRAP_SEED_DIRECTORY: seedDirectory,
    });
    break;
  }

  // bootstrap: the native bootstrap and self-rebuild contracts.
  case "bootstrap": {
    const [flavor, phase] = args;
    if (flavor !== "plain" && flavor !== "san") throw new Error("bootstrap needs plain or san");
    if (phase === undefined) throw new Error("bootstrap needs a phase");
    const env = {
      SCRIPTC_TEST_WORKERS: "1",
      SCRIPTC_SAN: flavor === "san" ? "1" : "",
      SCRIPTC_BOOTSTRAP_PHASE: phase,
      SCRIPTC_BOOTSTRAP_SEED_DIRECTORY: join(root, ".ci/bootstrap-seed", flavor),
      SCRIPTC_BOOTSTRAP_PACKAGE_DIR: join(
        mkdtempSync(join(tmpdir(), "scriptc-bootstrap-")),
        "native-cli-package",
      ),
      ...(phase === "commands" ? { SCRIPTC_LIBNODE: libnodeDirectory } : {}),
    };
    // The instrumented emitter's recursion can exceed the default 8 MiB stack.
    if (phase === "rebuild-emit")
      sh("ulimit -s unlimited; exec node scripts/ci-native-bootstrap.mjs", env);
    else run(process.execPath, ["scripts/ci-native-bootstrap.mjs"], env);
    break;
  }

  // native_profile: the native compiler built with the committed profile,
  // within the self-compile budget.
  case "native-profile": {
    run(process.execPath, ["scripts/self-compile-budget.mjs", "--native-build"], {
      SCRIPTC_NATIVE_PROFILE_CHECK: "1",
    });
    break;
  }

  // llvm_artifacts_linux_x64: the glibc helper and runtime pack with no clang
  // on PATH, a reachability check, and the Debian 12 glibc 2.36 smoke.
  case "llvm-artifacts": {
    const work = mkdtempSync(join(tmpdir(), "scriptc-llvm-artifacts-"));
    const traps = join(work, "traps");
    mkdirSync(traps, { recursive: true });
    for (const tool of ["clang", "cc", "gcc", "ar", "ld"]) {
      writeFileSync(join(traps, tool), "#!/bin/sh\nexit 97\n");
      chmodSync(join(traps, tool), 0o755);
    }
    const object = join(work, "hello.o");
    run(
      process.execPath,
      [
        "packages/cli/dist/main.js",
        "build",
        "tests/corpus/001-hello.ts",
        "--emit=obj",
        "-o",
        object,
      ],
      { PATH: `${traps}:${baseEnv.PATH}` },
    );
    assertElfObject(object);
    const executable = join(work, "hello");
    run(
      process.execPath,
      ["packages/cli/dist/main.js", "build", "tests/corpus/001-hello.ts", "-o", executable],
      { SCRIPTC_NO_CACHE: "1", SCRIPTC_LEGACY_C_PIPELINE: "0" },
    );
    if (output(executable, []).trim() !== "hello world")
      throw new Error("the built executable did not print hello world");
    pnpm(["test", "tests/harness/runtime-tree-shaking.test.ts"]);
    run("docker", [
      "run",
      "--rm",
      "--volume",
      `${root}:/work:ro`,
      "--workdir",
      "/work",
      "node:24-bookworm-slim",
      "sh",
      "-ec",
      [
        "apt-get update",
        "apt-get install --yes --no-install-recommends clang",
        "SCRIPTC_NO_CACHE=1 SCRIPTC_LEGACY_C_PIPELINE=0 node packages/cli/dist/main.js build tests/corpus/001-hello.ts -o /tmp/hello",
        'test "$(/tmp/hello)" = "hello world"',
      ].join("\n"),
    ]);
    break;
  }

  // llvm_artifacts_linux_x64_musl: the static musl helper, with no clang on
  // PATH, run under Alpine, and the executable hardening contract for both
  // libc flavors.
  case "llvm-artifacts:musl": {
    const helper = "packages/llvm-linux-x64-musl/bin/scriptc-llvm-codegen";
    if (!existsSync(join(root, helper))) throw new Error(`${helper} is missing`);
    assertNoInterpreter(join(root, helper));
    const identity = output("docker", [
      "run",
      "--rm",
      "--volume",
      `${root}:/work:ro`,
      "alpine:3.22",
      `/work/${helper}`,
      "version",
      "--format=json",
    ]);
    const version = JSON.parse(identity);
    if (
      version.default_target !== "x86_64-unknown-linux-musl" ||
      !version.supported_targets?.includes("wasm32-unknown-wasi")
    )
      throw new Error(`the musl helper reported an unexpected identity: ${identity}`);
    pnpm(["test", "tests/harness/executable-hardening.test.ts"]);
    break;
  }

  // llvm_artifacts_linux_x64_wasi: the wasm32-wasi runtime pack and the WASI
  // helper object and runtime-pack smoke.
  case "llvm-artifacts:wasi": {
    pnpm([
      "test",
      "packages/cli/test/wasi-runtime-pack.test.ts",
      "tests/harness/wasm-library.test.ts",
    ]);
    break;
  }

  default: {
    throw new Error(`unknown lane ${JSON.stringify(lane)}`);
  }
}
