import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Case-sharded harnesses run in every job without Vitest file sharding.
export const effectFiles = ["tests/harness/effect.test.ts", "tests/harness/effect4.test.ts"];
export const corpusFiles = [
  "tests/harness/differential.test.ts",
  "tests/harness/llvm-differential.test.ts",
  "tests/harness/npm.test.ts",
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
  ["self-hosting LLVM emitter", "tests/harness/self-hosting-llvm-emitter.test.ts"],
  ["fetch", "tests/harness/fetch.test.ts"],
  ["surface manifest", "tests/harness/surface-manifest.test.ts"],
];
// Suites that split their own tests across the shards (SCRIPTC_TEST_SHARD,
// skipUnownedTest in tests/harness/shard.ts): every shard runs its share in
// its own vitest process.
export const caseShardedSideFiles = [["npm static", "tests/harness/npm-static.test.ts"]];
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

// The shard (1-based) of each measured side-queue file and isolated suite:
// longest first to the shard with the least work so far, counting about a
// second per file for vitest to import it. Ties go to the highest shard, so the
// longest files start from the last shard while the cost-balanced corpus and
// three.js cases (tests/harness/shard.ts) place their longest from the first.
// An isolated suite or memory-heavy file without a measurement weighs as much
// as the median measured file. Memory-heavy files are placed after the others,
// each on the shard with the least memory-heavy work so far and, among those,
// the least work. Files without a
// measurement are left to vitest's --shard, which splits them by count.
export function sideOwners(flavor, count) {
  const costs = testCosts[flavor];
  const known = Object.values(costs).sort((a, b) => a - b);
  const median = known.length === 0 ? 0 : known[Math.floor(known.length / 2)];
  const weight = (file) => (costs[file] ?? median) + 1000;
  const heavy = Object.keys(memoryHeavyFiles).sort(
    (a, b) => memoryHeavyFiles[b] - memoryHeavyFiles[a] || (a < b ? -1 : a > b ? 1 : 0),
  );
  const files = [
    ...new Set([...Object.keys(costs), ...isolatedFiles.map(([, file]) => file)]),
  ].filter((file) => !(file in memoryHeavyFiles));
  files.sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const loads = new Array(count).fill(0);
  const memory = new Array(count).fill(0);
  const owners = new Map();
  for (const file of files) {
    let lightest = count - 1;
    for (let shard = count - 2; shard >= 0; shard--)
      if (loads[shard] < loads[lightest]) lightest = shard;
    loads[lightest] += weight(file);
    owners.set(file, lightest + 1);
  }
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
  }
  return owners;
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
  "packages/runtime/test/string.test.ts",
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
  const owners = sideOwners(flavor, count);
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
        ...[...new Set([...fileExclusions, ...owners.keys()])].map((file) => "--exclude=" + file),
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
    side.push({ name, args: ["test", file], env: { ...env, SCRIPTC_TEST_WORKERS: "1" } });
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
