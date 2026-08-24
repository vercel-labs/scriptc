#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  sandboxImageConfig,
  sandboxRunnerConfig,
  sandboxTestWorkerAllocation,
} from "./sandbox-config.mjs";
import {
  sandboxHostSchedule,
  sandboxLaneEnv,
} from "./sandbox-platform.mjs";
import {
  filterExistingWorktreePaths,
  workspaceResetCommand,
} from "./worktree-files.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const laneCaseShardedFiles = [
  "tests/harness/differential.test.ts",
  "tests/harness/llvm-differential.test.ts",
  "tests/harness/npm.test.ts",
  "tests/harness/server.test.ts",
];
// Coverage analysis is frontend-only: SCRIPTC_SAN cannot change its result.
// It still case-shards across the selected lane so every corpus entry is
// checked, but running the same sweep in the second lane adds no coverage.
const invariantCaseShardedFiles = ["tests/harness/coverage.test.ts"];
// Native-cache invalidation cases mutate process-wide compiler inputs and
// deliberately disable the immutable-toolchain memo used by the differential
// corpus. Keep them in their own Vitest process, matching CI: co-scheduling
// this file with the corpus can consume one of the corpus workers with the
// strict (and intentionally expensive) production probe path.
//
// They are sanitizer-invariant and use their own shard variable so the
// independent cases can spread across the once lane's Sandboxes without
// colliding with corpus case selection.
const cacheCaseShardedFiles = ["packages/compiler/src/backend/native-toolchain.test.ts"];
const caseShardedFiles = [
  ...laneCaseShardedFiles,
  ...invariantCaseShardedFiles,
  ...cacheCaseShardedFiles,
];

// These files neither consume SCRIPTC_SAN nor delegate to a helper that does.
// Run their full coverage once. Files absent from this allowlist remain in
// both lanes by default, so a new test never silently loses sanitizer coverage.
const invariantRemoteFiles = [
  "packages/cli/test/flush.test.ts",
  "packages/cli/test/paths.test.ts",
  "packages/compiler/src/library/int-infer.test.ts",
  "packages/compiler/test/cjs-lexer.test.ts",
  "packages/compiler/test/emit-c.test.ts",
  "packages/compiler/test/ir.test.ts",
  "packages/compiler/test/llvm-runtime-abi.test.ts",
  "packages/compiler/test/ts7/bench.test.ts",
  "packages/compiler/test/ts7/coverage.test.ts",
  "packages/compiler/test/ts7/facade.test.ts",
  "packages/compiler/test/ts7/order-parity.test.ts",
  "packages/compiler/test/ts7/parity.test.ts",
  "packages/compiler/test/ts7/program-adapter.test.ts",
  "packages/compiler/test/ts7/resolver-parity.test.ts",
  // These C runtime units compile with ASan + SCR_RC_AUDIT themselves.
  "packages/runtime/test/array.test.ts",
  "packages/runtime/test/bytes.test.ts",
  "packages/runtime/test/closure.test.ts",
  "packages/runtime/test/inspect.test.ts",
  "packages/runtime/test/json.test.ts",
  "packages/runtime/test/map.test.ts",
  "packages/runtime/test/path.test.ts",
  "packages/runtime/test/regex.test.ts",
  "tests/harness/island-surface.test.ts",
  "tests/harness/library-mode.test.ts",
  "tests/harness/library-profile.test.ts",
  "tests/harness/linux-differential.test.ts",
  "tests/harness/oci-manifest.test.ts",
  "tests/harness/sandbox-config.test.ts",
  "tests/harness/sandbox-platform.test.ts",
  "tests/harness/shard.test.ts",
  "tests/harness/smoke.test.ts",
  "tests/harness/surface-manifest.test.ts",
  "tests/harness/windows-differential.test.ts",
  "tests/harness/worktree-files.test.ts",
];

// Full native-oracle coverage stays on the host where the expected answer
// really is Darwin-, libc-, architecture-, or linker-specific. Each test is
// already explicitly sanitized where useful, so a second flavor is identical.
const hostInvariantFiles = [
  "packages/compiler/test/cc-driver.test.ts",
  "packages/runtime/test/lib.test.ts",
  "packages/runtime/test/number.test.ts",
  "packages/runtime/test/runtime.test.ts",
  "packages/runtime/test/string.test.ts",
  "packages/runtime/test/tonumber.test.ts",
  "packages/runtime/test/url.test.ts",
];
const hostSchedule = sandboxHostSchedule(process.platform, hostInvariantFiles);
const nativeHostInvariantFiles = hostSchedule.localInvariantFiles;
const remoteWorkspaceReset = workspaceResetCommand("/workspace");

// The full portable behavior of these suites runs remotely. A compact
// host-native contract additionally pins the places Darwin can disagree:
// object/archive ABI, Mach-O size classes, linker diagnostics, ucontext,
// and the kqueue event-loop arms under both ordinary and Apple-ASan builds.
// Non-Darwin hosts retain the full portable remote suites without trying
// to execute these macOS-specific contracts locally.
const hostLaneContractFiles = [
  "tests/harness/ffi.test.ts",
  "tests/harness/island.test.ts",
  "tests/harness/library-multi.test.ts",
  "tests/harness/differential.test.ts",
  "tests/harness/server.test.ts",
  "tests/harness/dgram.test.ts",
  "tests/harness/event-loop.test.ts",
];
const hostLaneContractPattern = [
  "calls the manifest-bound archive across every v1 ABI class",
  "a missing FFI symbol is an SC5004 diagnostic",
  "deep island recursion on a fiber is a catchable RangeError",
  "M1: external definitions equal the declared set exactly",
  "M2: independent state and collects",
  "M6: four threads, one archive",
  "M7: thread-instanced and runtime-localized archives compose",
  "M8: M6 under ASan",
  "net-echo",
  "udp-loopback-pair",
  "1564-fs-watch.ts",
  "1470-child-lifecycle.ts",
  "read-all: chunked writes with delays, then EOF",
].join("|");
const hostInvariantContractFiles = [
  "tests/harness/island.test.ts",
  "tests/harness/library-mode.test.ts",
  "tests/harness/regex.test.ts",
];
const hostInvariantContractPattern = [
  "static hello-world stays in its size class",
  "K1/K2/K8: scalar round-trips, symbol exactness, ambient audit",
  "K3: buffer round-trips \\+ lifetime, auto-reset posture",
  "K5: a trap delivers to the sink exactly once, host survives",
  "K10: K4 under ASan \\+ RC audit",
  "K10: K5/K7 under ASan",
  "regex-free programs never reference the regex runtime",
].join("|");

// Logically portable acceptance suites whose oracle lives in an external
// worktree that is intentionally not uploaded. Run them locally in both
// flavors, sharding suites whose individual cases are independently addressable.
const localLaneFiles = [
  "tests/harness/prettier-e2e.test.ts",
  "tests/harness/portless-e2e.test.ts",
];
const localCaseShardedFiles = ["tests/harness/vercel-e2e.test.ts"];

const { values } = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    keep: { type: "boolean" },
    lane: { type: "string", default: "both" },
    "remote-only": { type: "boolean" },
    shards: { type: "string", default: "8" },
  },
});

if (values.help) {
  console.log(`Run the scriptc test suite across Vercel Sandboxes.

Usage:
  pnpm test:sandbox [--lane plain|san|both] [--shards 8] [--remote-only] [--keep]

Environment:
  SCRIPTC_SANDBOX_IMAGE     Fully qualified VCR image (required; may be in .env.local)
  SCRIPTC_SANDBOX_VCPUS     vCPUs per sandbox (default: 8)
  SCRIPTC_SANDBOX_TIMEOUT   sandbox and command timeout (default: 45m)
  SCRIPTC_TEST_WORKERS      Vitest workers per sandbox (default: 4)
  SCRIPTC_LOCAL_TEST_WORKERS Vitest workers per local lane (default: 2)
  SCRIPTC_LOCAL_CASE_SHARDS local shards per external suite lane (default: 2)`);
  process.exit(0);
}

const { project, sandboxImage: image, team } = sandboxImageConfig();
const {
  vcpus,
  testWorkers,
  localTestWorkers,
  localCaseShards,
  sandboxTimeout,
} = sandboxRunnerConfig();

if (!["plain", "san", "both"].includes(values.lane)) {
  throw new Error(`--lane must be plain, san, or both (got ${values.lane})`);
}
const shardCount = Number(values.shards);
if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > 10) {
  throw new Error(`--shards must be an integer from 1 to 10 (got ${values.shards})`);
}

const lanes = values.lane === "both" ? ["plain", "san"] : [values.lane];
const remoteWorkerCount = Number(testWorkers);
if (!Number.isInteger(remoteWorkerCount) || remoteWorkerCount < 1) {
  throw new Error(`SCRIPTC_TEST_WORKERS must be a positive integer (got ${testWorkers})`);
}
const fileWorkers = "1";
const localCaseShardCount = Number(localCaseShards);
if (!Number.isInteger(localCaseShardCount) || localCaseShardCount < 1) {
  throw new Error(`SCRIPTC_LOCAL_CASE_SHARDS must be a positive integer (got ${localCaseShards})`);
}
const onceLane = lanes.includes("plain") ? "plain" : lanes[0];
const specialFiles = [
  ...caseShardedFiles,
  ...invariantRemoteFiles,
  ...hostInvariantFiles,
  ...localLaneFiles,
  ...localCaseShardedFiles,
];
if (new Set(specialFiles).size !== specialFiles.length) {
  throw new Error("a test file cannot belong to more than one execution path");
}
const nonce = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const workers = lanes.flatMap((lane) =>
  Array.from({ length: shardCount }, (_, offset) => {
    const shard = offset + 1;
    return {
      lane,
      shard,
      label: `${lane} ${shard}/${shardCount}`,
      name: `scriptc-${lane}-${shard}-${nonce}`,
    };
  }),
);
const created = new Set();
const children = new Set();
let cleanupPromise;
let handlingSignal = false;

function lineWriter(destination, prefix, handleLine) {
  let buffered = "";
  return {
    write(chunk) {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!handleLine?.(line)) destination.write(`${prefix}${line}\n`);
      }
    },
    end() {
      if (buffered && !handleLine?.(buffered)) destination.write(`${prefix}${buffered}\n`);
    },
  };
}

function run(
  command,
  args,
  { env = {}, exitMarker, idleTimeoutMs, label, quiet = false, timeoutMs } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, NO_UPDATE_NOTIFIER: "1", ...env },
      stdio: quiet ? "ignore" : ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    const prefix = label ? `[${label}] ` : "";
    let remoteExitCode;
    let timedOut = false;
    let timeoutReason = "";
    let killTimeout;
    const stopForTimeout = (reason) => {
      if (timedOut) return;
      timedOut = true;
      timeoutReason = reason;
      child.kill("SIGTERM");
      // A network-stalled CLI may not honor SIGTERM promptly. Escalate so a
      // wall timeout also bounds the time spent waiting for the close event.
      killTimeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            stopForTimeout(`after ${Math.round(timeoutMs / 1000)}s`);
          }, timeoutMs);
    let idleTimeout;
    const resetIdleTimeout = () => {
      if (idleTimeoutMs === undefined) return;
      if (idleTimeout !== undefined) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(
        () => stopForTimeout(`after ${Math.round(idleTimeoutMs / 1000)}s without output`),
        idleTimeoutMs,
      );
    };
    resetIdleTimeout();
    const stdout = lineWriter(process.stdout, prefix, (line) => {
      if (!exitMarker) return false;
      const match = new RegExp(`^${exitMarker}(\\d+)$`).exec(line);
      if (!match) return false;
      remoteExitCode = Number(match[1]);
      return true;
    });
    const stderr = lineWriter(process.stderr, prefix);
    if (!quiet) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        resetIdleTimeout();
        stdout.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        resetIdleTimeout();
        stderr.write(chunk);
      });
    }
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (idleTimeout !== undefined) clearTimeout(idleTimeout);
      if (killTimeout !== undefined) clearTimeout(killTimeout);
      children.delete(child);
      stdout.end();
      stderr.end();
      if (timedOut) {
        reject(
          Object.assign(new Error(`${label ?? command} timed out ${timeoutReason}`), {
            code: "SCRIPTC_RUN_TIMEOUT",
          }),
        );
      } else if (code !== 0) {
        reject(new Error(`${label ?? command} exited ${signal ?? code}`));
      } else if (exitMarker && remoteExitCode === undefined) {
        reject(new Error(`${label ?? command} did not report its remote exit status`));
      } else if (remoteExitCode !== undefined && remoteExitCode !== 0) {
        reject(new Error(`${label ?? command} remote command exited ${remoteExitCode}`));
      } else {
        resolve();
      }
    });
  });
}

const scopeArgs = ["--scope", team, "--project", project];
const vercel = ([group, command, ...args], options) =>
  run("vercel", [group, command, ...scopeArgs, ...args], options);
// `vercel sandbox exec` does not propagate the remote process's exit code.
// Print a per-command nonce after it finishes and enforce that status here.
const shellQuote = (value) => `'${value.replaceAll("'", `'\"'\"'`)}'`;
const execIn = async (worker, command, args, env = {}, task = "", wallTimeoutMs = 15 * 60_000) => {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  const exitMarker = `__SCRIPTC_REMOTE_EXIT_${randomBytes(12).toString("hex")}__`;
  const statusPath = `/tmp/${exitMarker}.status`;
  const script =
    `${[command, ...args].map(shellQuote).join(" ")}; scriptc_status=$?; ` +
    `printf '%s\\n' "$scriptc_status" > ${shellQuote(statusPath)}; ` +
    `printf '\\n${exitMarker}%s\\n' "$scriptc_status"`;
  const label = task ? `${worker.label} ${task}` : worker.label;
  const commandArgs = [
    "sandbox",
    "exec",
    "--timeout",
    sandboxTimeout,
    "--workdir",
    "/workspace",
    ...envArgs,
    worker.name,
    "sh",
    "-c",
    script,
  ];
  try {
    await vercel(commandArgs, {
      exitMarker,
      idleTimeoutMs: 90_000,
      label,
      timeoutMs: wallTimeoutMs,
    });
  } catch (error) {
    console.warn(`[${label}] CLI completion was not confirmed; checking the remote command status...`);
    const probeMarker = `__SCRIPTC_REMOTE_PROBE_${randomBytes(12).toString("hex")}__`;
    const probeScript =
      `scriptc_status=125; test ! -f ${shellQuote(statusPath)} || ` +
      `scriptc_status=$(cat ${shellQuote(statusPath)}); ` +
      `printf '\\n${probeMarker}%s\\n' "$scriptc_status"`;
    await vercel(
      [
        "sandbox",
        "exec",
        "--timeout",
        "1m",
        "--workdir",
        "/workspace",
        worker.name,
        "sh",
        "-c",
        probeScript,
      ],
      {
        exitMarker: probeMarker,
        idleTimeoutMs: 30_000,
        label: `${label} status`,
        timeoutMs: 60_000,
      },
    );
  }
};

async function createArchive(path) {
  const git = spawn("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const tarArgs = [
    ...(process.platform === "darwin" ? ["--no-xattrs", "--no-mac-metadata"] : []),
    "--null",
    "-T",
    "-",
    "-czf",
    path,
  ];
  const tar = spawn("tar", tarArgs, {
    cwd: root,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: ["pipe", "inherit", "inherit"],
  });
  children.add(git);
  children.add(tar);
  const pack = pipeline(git.stdout, filterExistingWorktreePaths(root), tar.stdin);
  const wait = (child, name) =>
    new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        children.delete(child);
        if (code === 0) resolve();
        else reject(new Error(`${name} exited ${signal ?? code}`));
      });
    });
  await Promise.all([wait(git, "git ls-files"), wait(tar, "tar"), pack]);
}

async function createWorker(worker) {
  const args = [
    "sandbox",
    "create",
    "--name",
    worker.name,
    "--image",
    image,
    "--timeout",
    sandboxTimeout,
    "--vcpus",
    vcpus,
    "--non-persistent",
  ];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await vercel(args, {
        idleTimeoutMs: 60_000,
        label: worker.label,
        timeoutMs: 2 * 60_000,
      });
      return;
    } catch {
      console.warn(`[${worker.label}] create completion was not confirmed; checking the Sandbox...`);
      try {
        await execIn(worker, "true", [], {}, "create status", 60_000);
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        console.warn(`[${worker.label}] Sandbox is not reachable; retrying creation once...`);
      }
    }
  }
}

async function uploadArchive(worker, archive) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await vercel(["sandbox", "copy", archive, `${worker.name}:/tmp/worktree.tar.gz`], {
        idleTimeoutMs: 60_000,
        label: worker.label,
        timeoutMs: 2 * 60_000,
      });
      return;
    } catch {
      console.warn(`[${worker.label}] copy completion was not confirmed; checking the remote archive...`);
      try {
        // Listing every member also verifies the gzip stream reached its
        // footer; a merely non-empty, partially uploaded file is rejected.
        await execIn(
          worker,
          "sh",
          ["-c", "tar -tzf /tmp/worktree.tar.gz >/dev/null"],
          {},
          "copy status",
          60_000,
        );
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        console.warn(`[${worker.label}] remote archive is absent or incomplete; retrying the copy once...`);
      }
    }
  }
}

async function allWorkers(phase, task, concurrency = workers.length) {
  const started = Date.now();
  console.log(`\n${phase} (${workers.length} sandboxes)...`);
  const results = [];
  for (let offset = 0; offset < workers.length; offset += concurrency) {
    results.push(...(await Promise.allSettled(workers.slice(offset, offset + concurrency).map(task))));
  }
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) {
    for (const failure of failures) console.error(failure.reason);
    throw new Error(`${phase} failed for ${failures.length} sandbox${failures.length === 1 ? "" : "es"}`);
  }
  console.log(`${phase} completed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function runTaskQueue(tasks, concurrency) {
  for (let offset = 0; offset < tasks.length; offset += concurrency) {
    await Promise.all(tasks.slice(offset, offset + concurrency).map((task) => task()));
  }
}

async function cleanup() {
  if (values.keep || created.size === 0) return;
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      console.log(`\nRemoving ${created.size} disposable sandbox${created.size === 1 ? "" : "es"}...`);
      const results = await Promise.allSettled(
        [...created].map((name) =>
          vercel(["sandbox", "remove", name], {
            label: name,
            quiet: true,
            timeoutMs: 60_000,
          }).then(() => created.delete(name)),
        ),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) {
        console.error(`Failed to remove ${failures.length} sandbox${failures.length === 1 ? "" : "es"}.`);
      }
    })();
  }
  await cleanupPromise;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (handlingSignal) return;
    handlingSignal = true;
    for (const child of children) child.kill("SIGTERM");
    if (!values.keep && created.size) {
      console.log(`\nRemoving ${created.size} disposable sandbox${created.size === 1 ? "" : "es"}...`);
      spawnSync(
        "vercel",
        ["sandbox", "remove", ...scopeArgs, ...created],
        {
          cwd: root,
          env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
          stdio: "inherit",
          timeout: 30_000,
        },
      );
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

const temp = await mkdtemp(join(tmpdir(), "scriptc-sandbox-test-"));
const archive = join(temp, "worktree.tar.gz");
const suiteStarted = Date.now();
let failure;

try {
  console.log(
    `Running ${lanes.join("+")} corpus lanes in ${workers.length} ${vcpus}-vCPU sandboxes from ${image} (${shardCount} shards/lane).`,
  );
  console.log("Packing the exact tracked + untracked, non-ignored worktree...");
  await createArchive(archive);

  const remote = (async () => {
    await allWorkers("Creating", async (worker) => {
      created.add(worker.name);
      await createWorker(worker);
    });

    await allWorkers(
      "Uploading worktree",
      (worker) => uploadArchive(worker, archive),
      8,
    );

    await allWorkers("Preparing worktree", async (worker) => {
      await execIn(
        worker,
        remoteWorkspaceReset.command,
        remoteWorkspaceReset.args,
        {},
        "reset",
        2 * 60_000,
      );
      await execIn(
        worker,
        "tar",
        ["-xzf", "/tmp/worktree.tar.gz", "-C", "/workspace"],
        {},
        "",
        2 * 60_000,
      );
      await execIn(worker, "pnpm", ["install", "--frozen-lockfile"], {}, "", 2 * 60_000);
      await execIn(worker, "pnpm", ["build"], {}, "", 2 * 60_000);
    });

    await allWorkers("Testing", async (worker) => {
      const sharedTestEnv = {
        ...sandboxLaneEnv(worker.lane),
        // Platform artifact contracts run against the native host below.
        // Remote lanes retain every portable behavior assertion.
        SCRIPTC_PORTABLE_ONLY: "1",
        ...(worker.lane === "san"
          ? {
              // Match the macOS shipping lane: Apple ASan has no
              // LeakSanitizer, while scriptc's RC audit owns leak
              // detection (including its intentional-abandonment rules).
              ASAN_OPTIONS: "detect_leaks=0",
            }
          : {}),
      };
      const workerCaseFiles = [
        ...laneCaseShardedFiles,
        ...(worker.lane === onceLane ? invariantCaseShardedFiles : []),
      ];
      const runCacheCases = worker.lane === onceLane;
      const { caseWorkers, sideConcurrency } = sandboxTestWorkerAllocation(
        remoteWorkerCount,
        runCacheCases ? 2 : 1,
      );
      const cases = () =>
        execIn(
          worker,
          "pnpm",
          ["test", "--reporter=dot", ...workerCaseFiles],
          {
            ...sharedTestEnv,
            SCRIPTC_TEST_SHARD: `${worker.shard}/${shardCount}`,
            SCRIPTC_TEST_WORKERS: String(caseWorkers),
          },
          "cases",
        );
      const files = () =>
        execIn(
          worker,
          "pnpm",
          [
            "test",
            "--reporter=dot",
            "--passWithNoTests",
            `--shard=${worker.shard}/${shardCount}`,
            ...caseShardedFiles.map((file) => `--exclude=${file}`),
            ...nativeHostInvariantFiles.map((file) => `--exclude=${file}`),
            ...localLaneFiles.map((file) => `--exclude=${file}`),
            ...localCaseShardedFiles.map((file) => `--exclude=${file}`),
            ...(worker.lane === onceLane
              ? []
              : [
                  ...invariantRemoteFiles,
                  ...hostSchedule.remoteInvariantFiles,
                ].map((file) => `--exclude=${file}`)),
          ],
          {
            ...sharedTestEnv,
            SCRIPTC_TEST_WORKERS: fileWorkers,
          },
          "files",
        );
      const cacheCases = () =>
        execIn(
          worker,
          "pnpm",
          ["test", "--reporter=dot", ...cacheCaseShardedFiles],
          {
            ...sharedTestEnv,
            SCRIPTC_CACHE_TEST_SHARD: `${worker.shard}/${shardCount}`,
            // This is the strict production-path contract. Keep it out of
            // the memoized corpus process and pin the opt-out explicitly,
            // just as the GitHub Actions matrix does.
            SCRIPTC_TEST_STABLE_TOOLCHAIN: "0",
            SCRIPTC_TEST_WORKERS: "1",
          },
          "cache",
        );
      // The corpus owns the remaining pool while file/cache processes share
      // the reserved side slots (serially when only one slot is available).
      const sideTasks = [files, ...(runCacheCases ? [cacheCases] : [])];
      if (sideConcurrency === 0) {
        await cases();
        await runTaskQueue(sideTasks, 1);
      } else {
        await Promise.all([
          cases(),
          runTaskQueue(sideTasks, sideConcurrency),
        ]);
      }
    });

    if (hostSchedule.remoteArtifactContracts) {
      const contractWorker = workers.find(
        (worker) => worker.lane === onceLane && worker.shard === 1,
      );
      if (!contractWorker) throw new Error("could not select a host artifact contract worker");
      console.log("\nTesting host artifact contracts in a Linux Sandbox...");
      await execIn(
        contractWorker,
        "pnpm",
        [
          "test",
          "--reporter=dot",
          "-t",
          hostInvariantContractPattern,
          ...hostInvariantContractFiles,
        ],
        {
          CI: "1",
          ASAN_OPTIONS: "detect_leaks=0",
          SCRIPTC_TEST_WORKERS: fileWorkers,
        },
        "host artifact contracts",
      );
    }
  })();

  const local = values["remote-only"]
    ? Promise.resolve()
    : (async () => {
        const hostName =
          process.platform === "darwin"
            ? "Darwin"
            : process.platform === "linux"
              ? "Linux"
              : process.platform;
        const localWork = [
          ...(nativeHostInvariantFiles.length > 0
            ? [`${nativeHostInvariantFiles.length} ${hostName}-native files`]
            : []),
          ...(hostSchedule.darwinContracts
            ? ["compact Darwin platform contracts"]
            : []),
          ...(hostSchedule.localArtifactContracts
            ? ["compact host artifact contracts"]
            : []),
          `${localLaneFiles.length + localCaseShardedFiles.length} external suites`,
        ];
        console.log(
          `\nBuilding and testing ${localWork.join(", ")} locally...`,
        );
        await run("pnpm", ["build"], { label: "local build" });
        const nativeHostTasks =
          nativeHostInvariantFiles.length === 0
            ? []
            : [
                run(
                  "pnpm",
                  [
                    "test",
                    ...nativeHostInvariantFiles,
                  ],
                  {
                    env: {
                      ...sandboxLaneEnv(onceLane),
                      SCRIPTC_TEST_WORKERS: localTestWorkers,
                    },
                    label: `local ${onceLane} ${hostName}`,
                  },
                ),
              ];
        const artifactContractTasks =
          !hostSchedule.localArtifactContracts
            ? []
            : [
                run(
                  "pnpm",
                  [
                    "test",
                    "--reporter=dot",
                    "-t",
                    hostInvariantContractPattern,
                    ...hostInvariantContractFiles,
                  ],
                  {
                    env: {
                      ...sandboxLaneEnv(onceLane),
                      ...(process.platform === "linux"
                        ? { ASAN_OPTIONS: "detect_leaks=0" }
                        : {}),
                      SCRIPTC_TEST_WORKERS: localTestWorkers,
                    },
                    label: `local ${onceLane} ${hostName} artifact contract`,
                  },
                ),
              ];
        const darwinContractTasks =
          !hostSchedule.darwinContracts
            ? []
            : lanes.map((lane) =>
                run(
                  "pnpm",
                  [
                    "test",
                    "--reporter=dot",
                    "-t",
                    hostLaneContractPattern,
                    ...hostLaneContractFiles,
                  ],
                  {
                    env: {
                      ...sandboxLaneEnv(lane),
                      SCRIPTC_TEST_WORKERS: localTestWorkers,
                    },
                    label: `local ${lane} Darwin contract`,
                  },
                ),
              );
        const laneFileTasks = lanes.map((lane) =>
          run(
            "pnpm",
            ["test", "--reporter=dot", ...localLaneFiles],
            {
              env: {
                ...sandboxLaneEnv(lane),
                SCRIPTC_TEST_RUN_ID: nonce,
                SCRIPTC_TEST_WORKERS: "1",
              },
              label: `local ${lane} external files`,
            },
          ),
        );
        const caseTasks = lanes.flatMap((lane) =>
          Array.from({ length: localCaseShardCount }, (_, offset) => {
            const shard = offset + 1;
            return run(
              "pnpm",
              ["test", "--reporter=dot", ...localCaseShardedFiles],
              {
                env: {
                  ...sandboxLaneEnv(lane),
                  SCRIPTC_TEST_SHARD: `${shard}/${localCaseShardCount}`,
                  SCRIPTC_TEST_RUN_ID: nonce,
                  SCRIPTC_TEST_WORKERS: "1",
                },
                label: `local ${lane} external ${shard}/${localCaseShardCount}`,
              },
            );
          }),
        );
        const results = await Promise.allSettled(
          [
            ...nativeHostTasks,
            ...artifactContractTasks,
            ...darwinContractTasks,
            ...laneFileTasks,
            ...caseTasks,
          ],
        );
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length) {
          for (const result of failures) console.error(result.reason);
          throw new Error(`${failures.length} local test lane${failures.length === 1 ? "" : "s"} failed`);
        }
      })();

  const results = await Promise.allSettled([remote, local]);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) {
    for (const result of failures) console.error(result.reason);
    throw new Error(`${failures.length} test path${failures.length === 1 ? "" : "s"} failed`);
  }

  console.log(
    `\n${lanes.length === 2 ? "Both test lanes" : `${lanes[0]} test lane`} passed in ${((Date.now() - suiteStarted) / 60_000).toFixed(1)} minutes.`,
  );
} catch (error) {
  failure = error;
} finally {
  await cleanup();
  await rm(temp, { recursive: true, force: true });
  if (values.keep && created.size) {
    console.log(`Kept sandboxes:\n${[...created].map((name) => `  ${name}`).join("\n")}`);
  }
}

if (failure) throw failure;
