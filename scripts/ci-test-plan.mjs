import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { placeLongestFirst } from "../tests/harness/shard-balance.mjs";

// Case-sharded harnesses run in every job without Vitest file sharding.
export const effectFiles = ["tests/harness/effect.test.ts", "tests/harness/effect4.test.ts"];
export const corpusFiles = [
  "tests/harness/differential.test.ts",
  "tests/harness/llvm-differential.test.ts",
  "tests/harness/npm.test.ts",
  "tests/harness/npm-shape-overlay.test.ts",
  "tests/harness/server.test.ts",
  "tests/harness/test262.test.ts",
  "tests/harness/three.test.ts",
];
const coverageFile = "tests/harness/coverage.test.ts";
const cacheFile = "packages/compiler/src/backend/native-toolchain.test.ts";
// Expensive integration suites run in their own vitest process, serially
// beside the corpus, avoiding worker contention between large compilations.
export const isolatedFiles = [
  ["self-hosting serialization", "tests/harness/self-hosting-serialization.test.ts"],
  ["self-hosting", "tests/harness/self-hosting.test.ts"],
  ["fetch", "tests/harness/fetch.test.ts"],
  ["surface manifest", "tests/harness/surface-manifest.test.ts"],
];
// Suites that split their own tests across the shards (SCRIPTC_TEST_SHARD,
// skipUnownedTest in tests/harness/shard.ts): every shard runs its share in
// its own vitest process. Every file that calls skipUnownedTest belongs here:
// vitest's --shard would give the whole file to one shard, which then skips
// the tests the other shards own.
export const caseShardedSideFiles = [
  ["npm static", "tests/harness/npm-static.test.ts"],
  ["self-hosting LLVM emitter", "tests/harness/self-hosting-llvm-emitter.test.ts"],
  ["three.js library", "tests/harness/three-library.test.ts"],
  ["program host reuse parity", "tests/harness/ts7-host-reuse-parity.test.ts"],
];
/** The cost table of a suite that splits its own tests: `<suite>-costs.json` beside the test file. */
export function caseCostsPath(file) {
  return file.replace(/\.test\.ts$/, "-costs.json");
}
// Milliseconds each of those suites' tests takes on a CI runner, per flavor
// and test name, from the same logs (scripts/ci-test-costs.mjs refreshes
// them). The suite balances its tests with the same table.
export const caseCosts = Object.fromEntries(
  caseShardedSideFiles.map(([, file]) => [
    file,
    JSON.parse(readFileSync(new URL("../" + caseCostsPath(file), import.meta.url), "utf8")),
  ]),
);
export const fileExclusions = [
  ...corpusFiles,
  ...effectFiles,
  coverageFile,
  cacheFile,
  ...isolatedFiles.map(([, file]) => file),
  ...caseShardedSideFiles.map(([, file]) => file),
  "tests/harness/self-hosting-native-driver.test.ts",
];

// Milliseconds each side-queue file takes on a CI runner, per flavor, from the
// logs of green main runs (scripts/ci-test-costs.mjs refreshes it).
export const testCosts = JSON.parse(
  readFileSync(new URL("./ci-test-costs.json", import.meta.url), "utf8"),
);

// Side-queue files whose process tree, run alone, peaks far above a plain
// vitest run (about 1 GB): megabytes at the peak, measured with CI's settings.
// They run beside the corpus task's three workers, so no two of them share a
// shard while there are shards without one.
export const memoryHeavyFiles = {
  "tests/harness/decl-boundary.test.ts": 1838,
};

// The sanitized self-hosting native-frontend build needs most of a 16 GB
// runner by itself: its clang compile of the whole frontend under ASan runs
// one clang per core, the largest of them 5.1 GB, beside a compile in Node
// that holds 6.5 to 7.4 GB. Beside a shard's corpus workers an OOM killed it
// intermittently (SIGKILL at 670-740 s, empty stderr, every test skipped).
// The sanitized Linux suite runs these three files in the
// native_frontend_san jobs (.github/workflows/ci.yml), one file per job with
// one worker and no corpus, on two of the runner's cores: four clangs at once
// no longer fit. The plain suite and the macOS shards keep them in
// the shard side queue, where the compiler's peak fits (macOS has no
// LeakSanitizer and runs these files one at a time beside the corpus).
export const nativeFrontendFiles = [
  "tests/harness/self-hosting-native-frontend.test.ts",
  "tests/harness/self-hosting-native-frontend-programs.test.ts",
  "tests/harness/self-hosting-native-frontend-checks.test.ts",
];

/** The files a shard job leaves to a dedicated job. */
export function dedicatedFiles(flavor, platform = process.platform) {
  return flavor === "san" && platform === "linux" ? nativeFrontendFiles : [];
}

// The side queue of every shard, planned as one load per shard in measured
// milliseconds. The suites that split their own tests come first, the one with
// the longest test first: each starts from the load the suites before it left
// (`starts`, which its shard processes receive as SCRIPTC_TEST_SHARD_LOADS),
// and places its tests longest first on the shard with the least so far
// (tests/harness/shard-balance.mjs; the planner places the measured tests as
// the suite will). The measured side-queue files and isolated suites follow by
// the same rule, counting about a second per file for vitest to import it; an
// isolated suite or memory-heavy file without a measurement weighs as much as
// the median measured file. So the longest tests of different suites land on
// different shards, and a test longer than an even share holds a shard's side
// queue alone. Memory-heavy files are placed before the other files, each on
// the shard with the least memory-heavy work so far and, among those, the
// least work, so the files that follow level the shards around them. Files
// without a measurement are left to vitest's --shard, which splits them by
// count. `owners` is the shard (1-based) of each whole file, and `loads` the
// planned milliseconds of each shard.
export function sidePlan(flavor, count, platform = process.platform) {
  const costs = testCosts[flavor];
  const known = Object.values(costs).sort((a, b) => a - b);
  const median = known.length === 0 ? 0 : known[Math.floor(known.length / 2)];
  const weight = (file) => (costs[file] ?? median) + 1000;
  const heavy = Object.keys(memoryHeavyFiles).sort(
    (a, b) => memoryHeavyFiles[b] - memoryHeavyFiles[a] || (a < b ? -1 : a > b ? 1 : 0),
  );
  const dedicated = new Set(dedicatedFiles(flavor, platform));
  const files = [
    ...new Set([...Object.keys(costs), ...isolatedFiles.map(([, file]) => file)]),
  ].filter((file) => !dedicated.has(file) && !(file in memoryHeavyFiles));
  const loads = new Array(count).fill(0);
  const memory = new Array(count).fill(0);
  const starts = new Map();
  const longest = (file) => Math.max(0, ...Object.values(caseCosts[file][flavor]));
  const suites = caseShardedSideFiles
    .map(([, file]) => file)
    .sort((a, b) => longest(b) - longest(a) || (a < b ? -1 : a > b ? 1 : 0));
  // What the plan puts on each shard: [file, test or undefined, milliseconds].
  const placed = Array.from({ length: count }, () => []);
  for (const file of suites) {
    starts.set(
      file,
      loads.map((load) => Math.round(load)),
    );
    const tests = Object.entries(caseCosts[file][flavor]).map(([key, cost]) => ({
      key,
      weight: Math.max(1, cost),
    }));
    const slices = placeLongestFirst(tests, loads);
    for (const { key, weight } of tests) placed[slices.get(key)].push([file, key, weight]);
  }
  const owners = new Map();
  for (const file of heavy) {
    let lightest = count - 1;
    for (let shard = count - 2; shard >= 0; shard--)
      if (
        memory[shard] < memory[lightest] ||
        (memory[shard] === memory[lightest] && loads[shard] < loads[lightest])
      )
        lightest = shard;
    memory[lightest] += memoryHeavyFiles[file];
    loads[lightest] += weight(file);
    owners.set(file, lightest + 1);
    placed[lightest].push([file, undefined, weight(file)]);
  }
  for (const [file, shard] of placeLongestFirst(
    files.map((file) => ({ key: file, weight: weight(file) })),
    loads,
  )) {
    owners.set(file, shard + 1);
    placed[shard].push([file, undefined, weight(file)]);
  }
  return { owners, starts, loads, placed };
}

/** The shard (1-based) of each measured side-queue file and isolated suite. */
export function sideOwners(flavor, count, platform = process.platform) {
  return sidePlan(flavor, count, platform).owners;
}

// Pull requests and pushes to main run the full suite on Linux. Pull requests
// that change darwin code (scripts/ci-lanes.mjs) also run the darwin suite on
// macOS, which keeps the darwin clang/libc/kqueue oracles: the Node
// differential corpus, plus every file whose assertions run only on darwin or
// take darwin-specific branches (including the Mach-O library localization arm
// and the arm64 runtime string oracle). Pushes to main run no macOS jobs. The
// nightly schedule and manual runs run the full suite on macOS, or the darwin
// suite with macos_suite set to darwin.
export const darwinCorpusFiles = ["tests/harness/differential.test.ts"];
export const darwinFiles = [
  "packages/cli/test/bootstrap.test.ts",
  "packages/cli/test/native-link-info.test.ts",
  "packages/cli/test/native-output.test.ts",
  "packages/cli/test/runtime-pack.test.ts",
  "packages/compiler/test/debug-variables.test.ts",
  "packages/compiler/test/native-codegen-integration.test.ts",
  "packages/compiler/test/source-debugging.test.ts",
  "packages/runtime-darwin-arm64/test/archive.test.ts",
  "packages/runtime/src/scr_alloc.test.ts",
  "packages/runtime/test/string.test.ts",
  "tests/harness/executable-hardening.test.ts",
  "tests/harness/ffi-callback-pool.test.ts",
  "tests/harness/ffi-catalog.test.ts",
  "tests/harness/ffi-frameworks.test.ts",
  "tests/harness/library-callbacks.test.ts",
  "tests/harness/library-dispatch.test.ts",
  "tests/harness/library-multi.test.ts",
  "tests/harness/native-object-example.test.ts",
  "tests/harness/runtime-tree-shaking.test.ts",
  "tests/harness/terminal-geometry.test.ts",
];

// LeakSanitizer over the sanitized corpus on Linux (macOS ASan has none, and
// the workflow keeps it off everywhere else): a leak fails its program. The
// suppressions file lists intentional leaks, with the reason for each.
export const leakSuppressions = fileURLToPath(
  new URL("../tests/harness/lsan.supp", import.meta.url),
);

// The sanitized three.js nodes build runs in its own Linux job
// (three_nodes_san in .github/workflows/ci.yml). Beside the corpus's other
// workers it took 860 to more than 1200 seconds, past its test timeout.
export const sanitizedNodesJobEnv = { SCRIPTC_THREE_SANITIZED_NODES_JOB: "1" };

function corpusThreeEnv(flavor, platform) {
  return flavor === "san" && platform === "linux" ? sanitizedNodesJobEnv : {};
}

function corpusLeakEnv(flavor, platform) {
  if (flavor !== "san" || platform !== "linux") return {};
  return {
    ASAN_OPTIONS: "detect_leaks=1",
    LSAN_OPTIONS: `suppressions=${leakSuppressions}:print_suppressions=0`,
  };
}

export function ciTestPlan({
  shard,
  flavor,
  workers = 4,
  suite = "full",
  platform = process.platform,
}) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  if (
    !match ||
    !Number.isSafeInteger(Number(match[1])) ||
    !Number.isSafeInteger(Number(match[2])) ||
    Number(match[1]) > Number(match[2])
  )
    throw new Error("invalid CI shard");
  if (flavor !== "plain" && flavor !== "san") throw new Error("invalid CI flavor");
  if (!Number.isInteger(workers) || workers < 1) throw new Error("invalid CI worker budget");
  if (suite !== "full" && suite !== "darwin") throw new Error("invalid CI suite");
  const index = Number(match[1]),
    count = Number(match[2]);
  const sideWorkers = workers === 1 ? 0 : 1;
  const env = { SCRIPTC_TEST_SHARD: shard, SCRIPTC_SAN: flavor === "san" ? "1" : "" };
  if (suite === "darwin") {
    // vitest runs one file's cases in sequence, so the shard's corpus cases
    // run as two halves in separate processes: case shards 2i-1 and 2i of
    // 2n. The second half follows the darwin contracts in the side queue.
    const half = (part) => ({
      name: `case-sharded differential corpus ${part}/2`,
      args: ["test", ...darwinCorpusFiles],
      env: {
        ...env,
        SCRIPTC_TEST_SHARD: `${2 * index - 2 + part}/${2 * count}`,
        SCRIPTC_TEST_WORKERS: "1",
      },
    });
    return {
      sideWorkers,
      corpus: half(1),
      side: [
        {
          name: "darwin contracts",
          args: ["test", "--passWithNoTests", "--shard=" + shard, ...darwinFiles],
          env: { ...env, SCRIPTC_TEST_WORKERS: "1" },
        },
        half(2),
      ],
    };
  }
  const { owners, starts } = sidePlan(flavor, count, platform);
  const dedicated = dedicatedFiles(flavor, platform);
  const isolated = new Set(isolatedFiles.map(([, file]) => file));
  const balanced = [...owners]
    .filter(([file, owner]) => owner === index && !isolated.has(file))
    .map(([file]) => file)
    .sort();
  const side = [
    {
      name: "file-sharded tests",
      args: [
        "test",
        "--passWithNoTests",
        "--shard=" + shard,
        ...[...new Set([...fileExclusions, ...owners.keys(), ...dedicated])].map(
          (file) => "--exclude=" + file,
        ),
      ],
      env: { ...env, SCRIPTC_TEST_WORKERS: "1" },
    },
  ];
  if (balanced.length > 0)
    side.push({
      name: "cost-balanced tests",
      args: ["test", "--passWithNoTests", ...balanced],
      env: { ...env, SCRIPTC_TEST_WORKERS: "1" },
    });
  for (const [name, file] of isolatedFiles) {
    if (owners.get(file) === index)
      side.push({ name, args: ["test", file], env: { ...env, SCRIPTC_TEST_WORKERS: "1" } });
  }
  for (const [name, file] of caseShardedSideFiles)
    side.push({
      name,
      args: ["test", file],
      env: {
        ...env,
        SCRIPTC_TEST_WORKERS: "1",
        SCRIPTC_TEST_SHARD_LOADS: starts.get(file).join(","),
      },
    });
  // Frontend coverage and cache invalidation do not consume sanitizer state.
  if (flavor === "plain") {
    side.push({
      name: "native-cache correctness",
      args: ["test", cacheFile],
      env: {
        ...env,
        SCRIPTC_TEST_WORKERS: "1",
        SCRIPTC_CACHE_TEST_SHARD: shard,
        SCRIPTC_TEST_STABLE_TOOLCHAIN: "0",
      },
    });
    side.push({
      name: "coverage sweep",
      args: ["test", coverageFile],
      env: { ...env, SCRIPTC_TEST_WORKERS: "1" },
    });
  }
  return {
    sideWorkers,
    corpus: {
      name: "case-sharded corpus",
      args: ["test", ...corpusFiles],
      env: {
        ...env,
        ...corpusLeakEnv(flavor, platform),
        ...corpusThreeEnv(flavor, platform),
        SCRIPTC_TEST_WORKERS: String(workers - sideWorkers),
        SCRIPTC_LLVM_TEST_MODE: "dev",
      },
    },
    side,
  };
}

// node scripts/ci-test-plan.mjs [shards] [platform] prints the planned side queue of every shard: its minutes, and
// with --items what the plan puts there.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const count = Number(args[0] ?? 20);
  const minutes = (ms) => (ms / 60_000).toFixed(1);
  for (const flavor of ["plain", "san"]) {
    const { loads, placed } = sidePlan(flavor, count, args[1] ?? "linux");
    const mean = loads.reduce((sum, load) => sum + load, 0) / count;
    console.log(
      `${flavor}: planned side queue, minutes per shard (mean ${minutes(mean)}, longest ${minutes(Math.max(...loads))})`,
    );
    loads.forEach((load, shard) => {
      console.log(
        `  ${String(shard + 1).padStart(2)}  ${minutes(load).padStart(5)}  ${placed[shard].length} items`,
      );
      if (process.argv.includes("--items"))
        for (const [file, test, ms] of placed[shard].toSorted((a, b) => b[2] - a[2]))
          console.log(
            `        ${minutes(ms).padStart(5)}  ${file}${test === undefined ? "" : ` > ${test}`}`,
          );
    });
  }
}
