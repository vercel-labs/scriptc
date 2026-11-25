#!/usr/bin/env node
// The tests a pull request's fast tier runs (fast_tests in .github/workflows/ci.yml).
//
// Four selections, all change-driven and none of them ever empty:
//
//   1. module graph     for changed TypeScript sources: the test files Vitest
//                       relates to them (listed, not run, by `vitest list`
//                       against a generated `related` config), selected
//                       within the same 20-minute single-worker budget.
//   2. stem matches     the test files named after the changed sources, the
//                       cheap historical rule, kept for C and runtime files.
//   3. corpus map       changed runtime C and compiler sources mapped to the
//                       corpus programs that import the Node module they
//                       serve (node:http, node:tls, node:fs, ...), run
//                       through the differential suite with -t.
//   4. smoke corpus     a curated ~3-minute corpus slice spanning the major
//                       runtime subsystems. It runs when 1-3 select nothing,
//                       and on every pull request with --smoke, so a change
//                       that maps nothing still runs real programs.
//
// The full suite runs when the pull request carries the ci:full label.
//
// usage: node scripts/ci-fast-tests.mjs --base <sha> --head <sha> [--dry-run]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fileExclusions,
  memoryHeavyFiles,
  nativeFrontendFiles,
  testCosts,
} from "./ci-test-plan.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// Single-worker milliseconds of the selected files, from scripts/ci-test-costs.json; the job runs four workers,
// so this is about five minutes of wall time.
export const FAST_TEST_BUDGET_MS = 20 * 60_000;

// Each selected file pays its start-up and collection before its tests, which the measured per-file costs do not
// include. The module graph can relate one shared compiler change to hundreds of small files: a 529-file related
// set spent this budget and still ran for 35 minutes. Charge the overhead, and cap the set; the rest waits for
// the full tier.
export const FILE_OVERHEAD_MS = 2_000;
export const MAX_TEST_FILES = 60;
export const MAX_CORPUS_PROGRAMS = 80;

// The curated smoke slice's own budget. It is smaller than the fast tier's:
// a fallback, not the tier.
export const SMOKE_BUDGET_MS = 3 * 60_000;

// The corpus suites, the isolated and case-sharded suites, and the memory-heavy files run only in the expensive
// tier: any one of them takes longer than the fast tier.
const expensiveOnly = new Set([
  ...fileExclusions,
  ...nativeFrontendFiles,
  ...Object.keys(memoryHeavyFiles),
]);

/** A test that needs the wasm32-wasi runtime pack says so in its source; the fast tier does not build that pack. */
export const WASI_RUNTIME_PACK_MARKER = "@requires-wasi-runtime-pack";

/** The tests that need @scriptc/runtime-wasm32-wasi/runtime-pack.json, read from their own marker. */
export function wasiRuntimePackTests(testFiles, root = repoRoot) {
  return testFiles.filter((file) => {
    try {
      return readFileSync(join(root, file), "utf8").includes(WASI_RUNTIME_PACK_MARKER);
    } catch {
      return false;
    }
  });
}

const isTest = (file) => file.endsWith(".test.ts");

/** The stem a source and its tests share: packages/compiler/src/backend/emit-call.ts -> emit-call. */
const stem = (file) => basename(file).replace(/(\.test)?\.(c|h|ts|mts|mjs|cjs|js)$/, "");

/** A ~3-minute slice spanning the runtime's major subsystems, by measured
 * cost (tests/harness/corpus-costs.json). Used only when nothing else matched:
 * every PR runs these rather than a green no-op. */
export const SMOKE_CORPUS = [
  "http-client-finished-flag.ts",
  "tls-check-server-identity-malformed.ts",
  "5632-promisify-dns.ts",
  "map-fs-watcher-values.ts",
  "crypto-sign-listener-cycle.ts",
  "util-format-json-error-added-properties.ts",
  "promise-all-settled-undefined.ts",
  "fs-stream-erased-open-listener.ts",
  "9477-child-signal-mask-start.ts",
  "url-namespace-functions.ts",
  "1610-path-win32-full.ts",
  "8913-regexp-method-values-typed.ts",
  "2562-intl-numberformat-en-us.ts",
  "sqlite-return-arrays.ts",
  "math-random-worker-streams.ts",
  "record-view-class-instance.ts",
  "nullish-empty-array-default.ts",
  "4477-buffer-write-ascii-runs.ts",
  "fetch-cache-request-headers.ts",
  "9437-zlib-input-of-several-kinds.ts",
  "dgram-lookup-capture.ts",
  "net-socket-chaining.ts",
  "optional-string-compound-accessor.ts",
  "typed-argument-number-key.ts",
  "2975-bigint-default-radix.ts",
];

/** The Node builtins a changed source's name points at. `scr_child.c` is
 * `node:child_process`, `scr_worker.c` is `node:worker_threads`, and a
 * compiler file such as `lib-http2.ts` or `builtin-signatures/fs.ts` names
 * its module directly. Tokens without a module (lower, emit, ir, ...) match
 * nothing here and fall through to the smoke slice. */
const MODULE_ALIASES = {
  child: ["child_process"],
  worker: ["worker_threads"],
  event: ["events"],
  events: ["events"],
  perf: ["perf_hooks"],
  string: ["string_decoder"],
  process: ["process"],
  timers: ["timers"],
  intl: ["intl"],
  regex: ["regexp"],
  regexp: ["regexp"],
  crypto: ["crypto"],
  http: ["http", "https"],
  http2: ["http2"],
  fetch: ["http", "https", "undici"],
  tcp: ["net"],
  dgram: ["dgram"],
  // WebCrypto is the crypto module's Web Crypto API; scr_webcrypto*.c serves node:crypto.
  webcrypto: ["crypto"],
};

/** Every Node module name a changed file's path tokens can name. */
export function moduleTokens(file) {
  const name = basename(file).replace(/\.(c|h|ts|mts|mjs|cjs|js)$/, "");
  const tokens = new Set(
    name
      .split(/[-_.]/)
      .map((token) => token.toLowerCase())
      .filter((token) => token.length > 1),
  );
  const modules = new Set();
  for (const token of tokens) {
    // Object.prototype's names (`constructor`, `toString`, ...) are not
    // aliases: MODULE_ALIASES[token] would answer the inherited function and
    // `for...of` would throw on a compiler file named e.g. constructor.ts.
    const alias = Object.hasOwn(MODULE_ALIASES, token) ? MODULE_ALIASES[token] : [token];
    for (const module of alias) modules.add(module);
  }
  return modules;
}

/** module -> the corpus programs whose entry imports it. Built once per run
 * from the corpus sources; a corpus program can import several. */
export function corpusModuleIndex(corpusDir) {
  const entries = [
    ...globSync(join(corpusDir, "*.{ts,js,mjs,cjs}")),
    ...globSync(join(corpusDir, "*/main.{ts,js,mjs,cjs}")),
  ].sort();
  const index = new Map();
  for (const entry of entries) {
    let source;
    try {
      source = readFileSync(entry, "utf8");
    } catch {
      continue;
    }
    const program = relative(corpusDir, entry).replaceAll("\\", "/");
    const seen = new Set();
    for (const match of source.matchAll(
      /(?:from\s*|require\(\s*|import\(\s*)["'](?:node:)?([a-z][a-z0-9_]*(?:\/[a-z0-9_.-]+)?)["']/g,
    )) {
      const module = match[1].split("/")[0];
      if (seen.has(module)) continue;
      seen.add(module);
      const programs = index.get(module) ?? index.set(module, []).get(module);
      programs.push(program);
    }
  }
  return index;
}

/**
 * The fast tier's test files and corpus programs for the changed paths,
 * cheapest first, within their budgets.
 * `testFiles` lists every test file in the repository; `costs` maps a test
 * file to its single-worker milliseconds (a file without a measurement
 * weighs as much as the median measured one). `related` are the test files
 * the module graph says import the changed sources; they compete for the
 * same budget as everything else, so a change to a shared compiler module
 * (which relates to hundreds of files) cannot outrun the budget. `corpusIndex`
 * maps a Node module to the corpus programs importing it, and `corpusCosts`
 * maps a corpus program to its single-worker milliseconds.
 */
export function fastTests(changed, testFiles, costs, budget = FAST_TEST_BUDGET_MS, options = {}) {
  const {
    related = [],
    corpusIndex = new Map(),
    corpusCosts = {},
    corpusBudget = SMOKE_BUDGET_MS,
    forceSmoke = false,
    excluded = expensiveOnly,
  } = options;
  const byStem = new Map();
  for (const file of testFiles) {
    const key = stem(file);
    byStem.set(key, [...(byStem.get(key) ?? []), file]);
  }
  const relatedCandidates = new Set(related.filter((file) => testFiles.includes(file)));
  const staticSelection = new Set(relatedCandidates);
  for (const file of changed) {
    if (isTest(file)) {
      if (testFiles.includes(file)) staticSelection.add(file);
      continue;
    }
    if (!/^(packages|scripts|tests\/harness)\//.test(file)) continue;
    for (const test of byStem.get(stem(file)) ?? []) staticSelection.add(test);
  }

  const known = Object.values(costs).sort((a, b) => a - b);
  const median = known.length === 0 ? 0 : known[Math.floor(known.length / 2)];
  const weigh = (file) => costs[file] ?? median;
  const selected = [];
  const deferred = [];
  let total = 0;
  let charged = 0;
  for (const file of [...staticSelection].sort(
    (a, b) => weigh(a) - weigh(b) || a.localeCompare(b),
  )) {
    const cost = weigh(file);
    if (
      excluded.has(file) ||
      selected.length >= MAX_TEST_FILES ||
      charged + cost + FILE_OVERHEAD_MS > budget
    )
      deferred.push(file);
    else {
      selected.push(file);
      total += cost;
      charged += cost + FILE_OVERHEAD_MS;
    }
  }

  // The subsystem map: corpus programs that import the module a changed
  // runtime/compiler source serves.
  const corpusSet = new Set();
  for (const file of changed) {
    if (isTest(file) || !/^(packages\/runtime\/src|packages\/compiler\/src)\//.test(file)) continue;
    for (const module of moduleTokens(file))
      for (const program of corpusIndex.get(module) ?? []) corpusSet.add(program);
  }
  const corpusKnown = Object.values(corpusCosts).sort((a, b) => a - b);
  const corpusMedian =
    corpusKnown.length === 0 ? 0 : corpusKnown[Math.floor(corpusKnown.length / 2)];
  const corpusWeigh = (program) => corpusCosts[program] ?? corpusMedian;
  const corpus = [];
  const deferredCorpus = [];
  // The mandatory smoke set is appended after this loop; leave it room inside the cap instead of pushing the
  // final list over it.
  const corpusLimit = forceSmoke
    ? Math.max(0, MAX_CORPUS_PROGRAMS - SMOKE_CORPUS.length)
    : MAX_CORPUS_PROGRAMS;
  let corpusTotal = 0;
  for (const program of [...corpusSet].sort(
    (a, b) => corpusWeigh(a) - corpusWeigh(b) || a.localeCompare(b),
  )) {
    if (corpus.length >= corpusLimit || corpusTotal + corpusWeigh(program) > corpusBudget)
      deferredCorpus.push(program);
    else {
      corpus.push(program);
      corpusTotal += corpusWeigh(program);
    }
  }

  // The related files that made it inside the budget (all of them are in
  // `selected`); reported apart so the log says where each file came from.
  const relatedSelected = selected.filter((file) => relatedCandidates.has(file));

  // Never select zero tests. If the related graph and both maps found
  // nothing, run the smoke slice: real corpus programs, on a 3-minute budget.
  let smoke = false;
  if (selected.length === 0 && corpus.length === 0) {
    smoke = true;
    for (const program of SMOKE_CORPUS) {
      if (corpus.length >= MAX_CORPUS_PROGRAMS || corpusTotal + corpusWeigh(program) > corpusBudget)
        deferredCorpus.push(program);
      else {
        corpus.push(program);
        corpusTotal += corpusWeigh(program);
      }
    }
  }

  // The fast tier asks for the smoke set on every pull request, not only as the fallback for an empty
  // selection. The set is mandatory: it runs even when mapped corpus programs have filled the change-driven
  // budget, so the tier always covers the major runtime subsystems. Programs already selected are not run twice.
  if (forceSmoke) {
    const present = new Set(corpus);
    for (const program of SMOKE_CORPUS) {
      if (present.has(program)) continue;
      if (corpus.length >= MAX_CORPUS_PROGRAMS) {
        deferredCorpus.push(program);
        continue;
      }
      present.add(program);
      corpus.push(program);
      corpusTotal += corpusWeigh(program);
    }
    for (let index = deferredCorpus.length - 1; index >= 0; index--)
      if (present.has(deferredCorpus[index])) deferredCorpus.splice(index, 1);
    smoke = true;
  }

  return {
    related: relatedSelected,
    selected,
    deferred,
    corpus,
    deferredCorpus,
    total,
    corpusTotal,
    smoke,
  };
}

/** The test files Vitest's module graph relates to the changed TS sources.
 *
 * Runs `vitest list` — collection only, no test bodies — against a generated
 * config whose `test.related` names the changes, rather than `vitest related`,
 * which would RUN every related file before the budget could consider it. The
 * option lives under `test`: a top-level `related` is ignored, and collection
 * would list every eligible test file for every change. A change to a shared
 * compiler module relates to hundreds of files; the list is handed back to
 * the caller, which selects within the fast tier's 20-minute single-worker
 * budget. The expensive suites are excluded so the import graph cannot pull
 * one in. */
function relatedTestFiles(changedTs, excluded = expensiveOnly) {
  if (changedTs.length === 0) return { status: 0, files: [] };
  const cacheDir = join(repoRoot, "node_modules/.cache");
  mkdirSync(cacheDir, { recursive: true });
  const configPath = join(cacheDir, `scriptc-fast-related-${process.pid}.mts`);
  const outputPath = join(cacheDir, `scriptc-fast-related-${process.pid}.json`);
  const baseConfig = pathToFileURL(join(repoRoot, "vitest.config.ts")).href;
  writeFileSync(
    configPath,
    `import base from ${JSON.stringify(baseConfig)};\n` +
      `export default { ...base, test: { ...base.test, related: JSON.parse(process.env["FAST_RELATED_FILES"] ?? "[]") } };\n`,
  );
  try {
    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "list",
        "--filesOnly",
        `--json=${outputPath}`,
        "-c",
        configPath,
        ...[...excluded].flatMap((file) => [`--exclude=${file}`]),
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, FAST_RELATED_FILES: JSON.stringify(changedTs) },
      },
    );
    if (result.status !== 0) {
      process.stderr.write(result.stderr ?? "");
      return { status: result.status ?? 1, files: [] };
    }
    try {
      const listed = JSON.parse(readFileSync(outputPath, "utf8"));
      const files = listed.map((entry) => relative(repoRoot, entry.file).replaceAll("\\", "/"));
      return { status: 0, files };
    } catch {
      return { status: 1, files: [] };
    }
  } finally {
    rmSync(configPath, { force: true });
    rmSync(outputPath, { force: true });
  }
}

async function main() {
  if (process.argv.includes("--wasi-tests")) {
    const files = globSync(["packages/*/{src,test}/**/*.test.ts", "tests/harness/**/*.test.ts"], {
      cwd: repoRoot,
      exclude: (path) => path.includes("node_modules"),
    }).sort();
    console.log(wasiRuntimePackTests(files).join(" "));
    return;
  }
  const index = process.argv.indexOf("--base");
  const base = index === -1 ? undefined : process.argv[index + 1];
  const headIndex = process.argv.indexOf("--head");
  const head = headIndex === -1 ? undefined : process.argv[headIndex + 1];
  if (!base || !head)
    throw new Error("usage: ci-fast-tests.mjs --base <sha> --head <sha> [--smoke] [--dry-run]");
  const dryRun = process.argv.includes("--dry-run");
  const forceSmoke = process.argv.includes("--smoke");
  const changed = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => file !== "" && existsSync(new URL(`../${file}`, import.meta.url)));
  const testFiles = globSync(["packages/*/{src,test}/**/*.test.ts", "tests/harness/**/*.test.ts"], {
    cwd: repoRoot,
    exclude: (path) => path.includes("node_modules"),
  }).sort();
  const corpusCosts = JSON.parse(
    readFileSync(join(repoRoot, "tests/harness/corpus-costs.json"), "utf8"),
  ).plain;
  const corpusIndex = corpusModuleIndex(join(repoRoot, "tests/corpus"));
  const changedTs = changed.filter(
    (file) => /\.[cm]?tsx?$/.test(file) && !isTest(file) && !file.endsWith(".d.ts"),
  );
  const excluded = new Set([...expensiveOnly, ...wasiRuntimePackTests(testFiles)]);
  const relatedRun = dryRun ? { status: 0, files: [] } : relatedTestFiles(changedTs, excluded);
  const selection = fastTests(changed, testFiles, testCosts.plain, FAST_TEST_BUDGET_MS, {
    related: relatedRun.files,
    corpusIndex,
    corpusCosts,
    forceSmoke,
    excluded,
  });

  const relatedSet = new Set(selection.related);
  console.log(
    `${changed.length} changed files; ` +
      `${selection.related.length} related + ${selection.selected.length - relatedSet.size} stem ` +
      `test files (~${Math.round((selection.total + selection.corpusTotal) / 60_000)} single-worker minutes) ` +
      `and ${selection.corpus.length} corpus programs${selection.smoke ? " (smoke fallback)" : ""}`,
  );
  for (const file of selection.related) console.log(`  related  ${file}`);
  for (const file of selection.selected)
    if (!relatedSet.has(file)) console.log(`  test     ${file}`);
  for (const program of selection.corpus) console.log(`  corpus   ${program}`);
  if (selection.deferred.length > 0) {
    console.log(`Left to the expensive tier (expensive suites or over the budget):`);
    for (const file of selection.deferred) console.log(`  ${file}`);
  }
  if (selection.deferredCorpus.length > 0)
    console.log(
      `${selection.deferredCorpus.length} mapped corpus programs over the smoke budget wait for the expensive tier`,
    );
  if (dryRun) {
    process.exitCode = relatedRun.status;
    return;
  }

  let failed = relatedRun.status !== 0;
  if (selection.selected.length > 0) {
    const result = spawnSync("pnpm", ["test", ...selection.selected], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    failed ||= (result.status ?? 1) !== 0;
  }
  if (selection.corpus.length > 0) {
    // The differential suite is case-selected by test name (the program's
    // repo-relative path), so -t chooses exactly the mapped programs.
    // -t matches the full name, which the suite prefixes with its describe
    // header, so anchor at the end only.
    const pattern = selection.corpus.map((program) =>
      program.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    const result = spawnSync(
      "pnpm",
      ["test", "tests/harness/differential.test.ts", "-t", `(?:${pattern.join("|")})$`],
      { cwd: repoRoot, stdio: "inherit" },
    );
    failed ||= (result.status ?? 1) !== 0;
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
