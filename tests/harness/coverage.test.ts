import { execFileSync, spawnSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  analyze,
  compile,
  coverageEnvelope,
  coveragePasses,
  renderCoverage,
  renderExplainDynamic,
  renderExplainIsland,
} from "@scriptc/compiler";
import { shardSelect, shardSuffix } from "./shard.js";

const repoRoot = join(import.meta.dirname, "../..");
const fixture = (name: string) => join(repoRoot, "tests/coverage-fixtures", name);

function report(path: string): string {
  const { coverage } = analyze(path);
  return renderCoverage(
    { ...coverage, file: coverage.file.replace(repoRoot + "/", "") },
    { root: repoRoot },
  );
}

test("mixed program: percentage and grouped blockers", async () => {
  await expect(report(fixture("mixed.ts"))).toMatchFileSnapshot("__snapshots__/coverage-mixed.txt");
});

test("unsupported operations appear as native compilation blockers", async () => {
  // constructs no flag fixes stay under "blockers".
  await expect(report(fixture("dynamic-mix.ts"))).toMatchFileSnapshot(
    "__snapshots__/coverage-dynamic-mix.txt",
  );
});

test("unreached blockers report in their own group", async () => {
  // Bodies nothing on the entry path reaches lower only for analysis:
  // their blockers render dim, under "in unreached code" — and the same
  // program BUILDS (the differential dead-strip tests pin that side).
  await expect(report(fixture("unreached.ts"))).toMatchFileSnapshot(
    "__snapshots__/coverage-unreached.txt",
  );
});

test("WebAssembly modules the build can see report with their sources", async () => {
  // A resolved path, a resolved .so shared library and an inline literal
  // (glue.js), a packaged .wasm (wasm-fixture-pkg), and package.json's
  // scriptc.wasm list. A resolved .so that is not a module is not reported.
  await expect(report(fixture("wasm/main.ts"))).toMatchFileSnapshot(
    "__snapshots__/coverage-wasm.txt",
  );
  const { coverage } = analyze(fixture("wasm/main.ts"), { wasm: [fixture("wasm/add.wasm")] });
  const modules = coverage.wasmModules ?? [];
  expect(
    modules.map((m) => [
      m.path?.replace(repoRoot + "/", "") ?? "inline",
      m.status,
      m.unsupported,
      m.sources.map((s) => s.kind),
    ]),
  ).toEqual([
    ["inline", "valid", [], ["inline"]],
    ["tests/coverage-fixtures/wasm/add.wasm", "valid", [], ["path", "config"]],
    ["tests/coverage-fixtures/wasm/ext.so", "valid", [], ["path"]],
    [
      "tests/coverage-fixtures/wasm/node_modules/wasm-fixture-pkg/lib/core.wasm",
      "invalid",
      [],
      ["package"],
    ],
    ["tests/coverage-fixtures/wasm/build/generated.wasm", "unsupported", ["simd"], ["config"]],
  ]);
  const envelope = coverageEnvelope(coverage, { compilerVersion: "test" });
  expect(envelope.wasmModules?.map((m) => m.sha256.length)).toEqual([64, 64, 64, 64, 64]);
});

test("divergences report as warnings, never as blockers", async () => {
  const { coverage } = analyze(fixture("divergences.ts"));
  expect(coverage.diagnostics).toEqual([]);
  expect((coverage.divergences ?? []).map((d) => d.code)).toEqual([
    "SC6001",
    "SC6001",
    "SC6002",
    "SC6003",
    "SC6004",
  ]);
  expect(coveragePasses(coverage, "blockers")).toBe(true);
  expect(coveragePasses(coverage, "divergences")).toBe(false);
  await expect(report(fixture("divergences.ts"))).toMatchFileSnapshot(
    "__snapshots__/coverage-divergences.txt",
  );
});

test("record width copies report at every storing site", async () => {
  const { coverage } = analyze(fixture("width-copies.ts"));
  expect(coverage.diagnostics).toEqual([]);
  expect((coverage.divergences ?? []).map((d) => d.code)).toEqual([
    "SC6001",
    "SC6001",
    "SC6001",
    "SC6001",
    "SC6001",
  ]);
  await expect(report(fixture("width-copies.ts"))).toMatchFileSnapshot(
    "__snapshots__/coverage-width-copies.txt",
  );
});

test("ordinary code reports no divergence", () => {
  const { coverage } = analyze(fixture("no-divergences.ts"));
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.divergences ?? []).toEqual([]);
});

test("likely-hot functions with untyped values report as a performance warning", async () => {
  const { coverage } = analyze(fixture("dynamic-tier/hot.js"));
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.divergences ?? []).toEqual([]);
  expect((coverage.performance ?? []).map((d) => d.code)).toEqual(["SC6101"]);
  // Not a blocker or a divergence: only --fail-on=dynamic fails on it.
  expect(coveragePasses(coverage, "divergences")).toBe(true);
  expect(coveragePasses(coverage, "dynamic")).toBe(false);
  const envelope = coverageEnvelope(coverage, { compilerVersion: "test" });
  expect(envelope.diagnostics.map((d) => [d.code, d.category, d.severity])).toEqual([
    ["SC6101", "performance", "warning"],
  ]);
  await expect(report(fixture("dynamic-tier/hot.js"))).toMatchFileSnapshot(
    "__snapshots__/coverage-dynamic-tier.txt",
  );
});

test("the performance warning names the untyped value of each function", () => {
  const { coverage } = analyze(fixture("dynamic-tier/typed-hot.ts"));
  expect(coverage.performance?.[0]?.message.split("\n")).toEqual([
    "4 functions that likely run often use untyped values, which runs slower than typed code:",
    "  regionTotals (typed-hot.ts:5): `items` is `any`, in a loop",
    "  entryCount (typed-hot.ts:26): `key` is `any`, in a loop",
    "  countRegions (typed-hot.ts:11): `parsed` holds an untyped `JSON.parse` result, in a loop",
    "  weights (typed-hot.ts:18): `rows` is `any`, in a loop",
  ]);
});

test("untyped setup code that runs once reports no performance warning", () => {
  const { coverage } = analyze(fixture("dynamic-tier/quiet.ts"));
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.performance).toBeUndefined();
  expect(coveragePasses(coverage, "dynamic")).toBe(true);
});

test("the performance warning names function expressions as the source does", () => {
  const { coverage } = analyze(fixture("dynamic-tier/function-names.js"));
  expect(coverage.performance?.[0]?.message.split("\n").slice(1)).toEqual([
    "  sum (function-names.js:5): untyped JavaScript file, in a loop",
    "  count (function-names.js:13): untyped JavaScript file, in a loop",
    "  scale (function-names.js:20): untyped JavaScript file, in a loop",
    "  anonymous function (function-names.js:27): untyped JavaScript file, in a loop",
  ]);
});

test("the performance warning names neither type names nor generated helpers", () => {
  const { coverage } = analyze(fixture("dynamic-tier/unnamed.ts"));
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.performance).toBeUndefined();
});

test("dynamic-tier code in npm packages is summarized by package", () => {
  const { coverage } = analyze(fixture("dynamic-tier/package/main.ts"));
  expect(coverage.performance?.[0]?.message.split("\n")).toEqual([
    "1 function that likely runs often uses untyped values, which runs slower than typed code:",
    "  sumAmounts (main.ts:6): `rows` is `any`, in a loop",
    "  untyped code in npm packages: untyped-lib (1 function)",
  ]);
});

test("statements of a signature-blocked function count as not static", () => {
  const { coverage } = analyze(fixture("blocked-signature.ts"));
  const un = coverage.unreached?.stats;
  expect(coverage.stats.functionsSkipped + (un?.functionsSkipped ?? 0)).toBe(1);
  // Two top-level statements plus the four the blocked body holds.
  expect(coverage.stats.statementsTotal + (un?.statementsTotal ?? 0)).toBe(6);
  expect(coverage.stats.statementsFailed + (un?.statementsFailed ?? 0)).toBe(5);
});

test("the body of a signature-blocked function reports its diagnostics", () => {
  const { coverage } = analyze(fixture("blocked-signature-body.ts"));
  const sites = (diags: readonly { code: string; message: string }[]) =>
    diags.map((d) => `${d.code} ${d.message}`).sort();
  // measure is called: its body's diagnostics join the reached ones.
  expect(sites(coverage.diagnostics)).toEqual([
    "SC2004 uses of 'extra' inherit the blocker on its declaration",
    "SC2004 uses of 'measure' inherit the blocker on its declaration",
    "SC2004 uses of 'target' inherit the blocker on its declaration",
    "SC2020 'WeakRef<object>' is part of the standard library types but has no scriptc lowering yet",
    "SC2020 'new WeakRef' is part of the standard library types but has no scriptc lowering yet",
  ]);
  // Nothing calls unused or described: their signatures and bodies report
  // as unreached. described's declared `this` is its receiver, so
  // `this.label` reports nothing.
  expect(sites(coverage.unreached?.diagnostics ?? [])).toEqual([
    "SC2004 uses of 'extra' inherit the blocker on its declaration",
    "SC2004 uses of 'target' inherit the blocker on its declaration",
    "SC2020 'WeakRef<object>' is part of the standard library types but has no scriptc lowering yet",
    "SC2020 'WeakRef<object>' is part of the standard library types but has no scriptc lowering yet",
    "SC2020 'new WeakRef' is part of the standard library types but has no scriptc lowering yet",
  ]);
  // The bodies' statements still count once each, as not static.
  const un = coverage.unreached?.stats;
  expect(coverage.stats.functionsSkipped + (un?.functionsSkipped ?? 0)).toBe(3);
  expect(coverage.stats.statementsTotal + (un?.statementsTotal ?? 0)).toBe(7);
  expect(coverage.stats.statementsFailed + (un?.statementsFailed ?? 0)).toBe(7);
});

test("deferred fences in a module's top-level code report as running at startup", () => {
  const { coverage, sourceTexts } = analyze(fixture("startup-fences.js"));
  expect(
    (coverage.runtimeFences ?? []).map((d) => [d.code, d.loc.start, d.startup === true]),
  ).toEqual([
    ["SC1090", expect.any(Number), true],
    ["SC1090", expect.any(Number), false],
  ]);
  const out = report(fixture("startup-fences.js"));
  expect(out).toMatch(
    /runs at startup {3}1 site .*\n.*instanceof against this native constructor\n\s+at tests\/coverage-fixtures\/startup-fences\.js:5:13/,
  );
  expect(out).toMatch(
    /deferred to runtime {3}1 site .*\n.*instanceof against this native constructor\n\s+at tests\/coverage-fixtures\/startup-fences\.js:7:10/,
  );
  const envelope = coverageEnvelope(coverage, { compilerVersion: "test", sourceTexts });
  expect(envelope.diagnostics.map((d) => [d.scope, d.line, d.startup])).toEqual([
    ["deferred", 5, true],
    ["deferred", 7, undefined],
  ]);
});

test("a failed unreached JavaScript statement is always explained", () => {
  const { coverage } = analyze(fixture("unreached-js-fence.js"));
  const failed =
    coverage.stats.statementsFailed + (coverage.unreached?.stats.statementsFailed ?? 0);
  expect(failed).toBe(1);
  const explained = [
    ...coverage.diagnostics,
    ...(coverage.runtimeFences ?? []),
    ...(coverage.unreached?.diagnostics ?? []),
    ...(coverage.unreached?.runtimeFences ?? []),
  ];
  expect(explained.map((d) => d.code)).toEqual(["SC1090"]);
  expect(report(fixture("unreached-js-fence.js"))).toContain(
    "at tests/coverage-fixtures/unreached-js-fence.js:7:",
  );
});

test("blocker groups carry a location and a hint", () => {
  const out = report(fixture("mixed.ts"));
  expect(out).toMatch(/at tests\/coverage-fixtures\/mixed\.ts:\d+:\d+/);
  expect(out).toContain("hint: ");
});

test("TypeScript errors caused by scriptc's type world say so", () => {
  const { coverage, sourceTexts } = analyze(fixture("type-world/main.ts"));
  expect(coverage.preflightFailed).toBe(true);
  const world = coverage.diagnostics.filter((d) => d.code === "SC0001" && d.typeWorld === true);
  expect(world.map((d) => d.hint)).toEqual([
    expect.stringContaining('ES2025 library regardless of the project\'s "lib"'),
    expect.stringContaining("'Deno' is another runtime's global"),
  ]);
  const out = renderCoverage(coverage, { sourceTexts });
  expect(out).toContain("come from scriptc's type world");
  const envelope = coverageEnvelope(coverage, { compilerVersion: "test", sourceTexts });
  expect(envelope.phase).toBe("preflight");
  expect(envelope.diagnostics.every((d) => d.category === "environment")).toBe(true);
});

test("coercing parseFloat and Number.parse* calls name their argument condition", () => {
  const { coverage } = analyze(fixture("parse-coercions.ts"));
  expect(coverage.diagnostics.map((d) => [d.code, d.message])).toEqual([
    ["SC2012", "'parseFloat' with a 'boolean' argument cannot compile statically"],
    ["SC2012", "'Number.parseInt' with a 'number' argument cannot compile statically"],
  ]);
  for (const d of coverage.diagnostics) expect(d.hint).toContain("convert the argument explicitly");
});

test("the diagnostics envelope is versioned and located", () => {
  const { coverage, sourceTexts } = analyze(fixture("mixed.ts"));
  const envelope = coverageEnvelope(coverage, { compilerVersion: "test", sourceTexts });
  expect(envelope).toMatchObject({
    schema: "scriptc-diagnostics",
    schemaVersion: 1,
    command: "coverage",
    success: false,
    phase: "compile",
    stats: { statementsTotal: 13, statementsStatic: 12, statementsFailed: 1, percentStatic: 92 },
  });
  expect(envelope.groups).toHaveLength(1);
  expect(envelope.diagnostics[0]).toMatchObject({
    code: "SC1031",
    category: "unsupported",
    severity: "error",
    scope: "reached",
    line: 13,
    column: 7,
    group: envelope.groups[0]!.id,
  });
  expect(envelope.diagnostics[0]!.hint.length).toBeGreaterThan(0);
});

test("CLI: --print=diagnostics and --fail-on set the output and exit status", () => {
  const scriptcCli = join(repoRoot, "packages/cli/src/main.ts");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", scriptcCli, "coverage", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, SCRIPTC_NO_CACHE: "1" },
    });
  const plain = run(fixture("mixed.ts"));
  expect(plain.status).toBe(0);
  const gated = run(fixture("mixed.ts"), "--fail-on=blockers");
  expect(gated.status).toBe(1);
  const json = run(fixture("mixed.ts"), "--print=diagnostics", "--fail-on=blockers");
  expect(json.status).toBe(1);
  const envelope = JSON.parse(json.stdout) as { schemaVersion: number; success: boolean };
  expect(envelope).toMatchObject({ schemaVersion: 1, success: false });
  expect(run(fixture("divergences.ts"), "--fail-on=blockers").status).toBe(0);
  expect(run(fixture("divergences.ts"), "--fail-on=divergences").status).toBe(1);
  // Unreached blockers cannot fail a build, so they never fail the gate.
  expect(run(fixture("unreached.ts"), "--fail-on=blockers").status).toBe(0);
  const bad = run(fixture("mixed.ts"), "--fail-on=everything");
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain('unknown --fail-on value "everything"');
});

test("CLI: build --print=diagnostics reports failures and divergence warnings as JSON", () => {
  const scriptcCli = join(repoRoot, "packages/cli/src/main.ts");
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-build-envelope-"));
  try {
    const build = (file: string, ...args: string[]) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          scriptcCli,
          "build",
          file,
          "--emit=ir",
          "-o",
          join(outDir, "out.ir.json"),
          ...args,
        ],
        { cwd: repoRoot, encoding: "utf8", env: { ...process.env, SCRIPTC_NO_CACHE: "1" } },
      );
    const failed = build(fixture("mixed.ts"), "--print=diagnostics");
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({
      command: "build",
      success: false,
      phase: "compile",
      diagnostics: [{ code: "SC1031", line: 13, column: 7 }],
    });
    const warned = build(fixture("divergences.ts"), "--print=diagnostics");
    expect(warned.status).toBe(0);
    const envelope = JSON.parse(warned.stdout) as {
      success: boolean;
      artifact: string;
      diagnostics: { code: string; severity: string }[];
    };
    expect(envelope.success).toBe(true);
    expect(envelope.artifact).toBe(join(outDir, "out.ir.json"));
    expect(envelope.diagnostics.map((d) => d.severity)).toEqual(Array(5).fill("warning"));
    const human = build(fixture("divergences.ts"));
    expect(human.status).toBe(0);
    expect(human.stderr).toContain("warning SC6001");
    expect(human.stderr).toContain("5 warnings: the program compiled");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("coverage counts the statements of dynamic-tier functions", async () => {
  expect(analyze(join(repoRoot, "tests/corpus/400-fib.ts")).coverage.stats.statementsDynamic).toBe(
    0,
  );
  const { coverage, sourceTexts } = analyze(fixture("tier-demotions.ts"));
  expect(coverage.stats.statementsDynamic).toBe(1);
  expect(coverage.tiers).toBeUndefined();
  expect(coverageEnvelope(coverage, { compilerVersion: "test", sourceTexts }).stats).toMatchObject({
    statementsTotal: 5,
    statementsStatic: 3,
    statementsDynamic: 1,
    statementsFailed: 2,
  });
  await expect(report(fixture("tier-demotions.ts"))).toMatchFileSnapshot(
    "__snapshots__/coverage-tier-demotions.txt",
  );
});

test("--explain-dynamic attributes each refusal to the unit the dynamic tier would take", async () => {
  const { coverage, sourceTexts } = analyze(fixture("tier-demotions.ts"), { explainDynamic: true });
  const tiers = coverage.tiers!;
  expect(tiers.mode).toBe("auto");
  expect(tiers.statementsDynamic).toBe(1);
  expect(tiers.dynamicFunctions.map((fn) => fn.name)).toContain("readName");
  const requests = [...tiers.requests].sort((a, b) => a.loc.start - b.loc.start);
  expect(
    requests.map((r) => [r.code, r.seed, r.scope, r.unit.kind, r.unit.name, r.enclosing.name]),
  ).toEqual([
    ["SC1090", "reflection", "reached", "class", "Point", "<top level>"],
    ["SC2020", "operation", "reached", "binding", "n", "precise"],
  ]);
  expect(tiers.units.map((u) => [u.kind, u.name, u.requests, u.sites])).toEqual([
    ["class", "Point", 1, 0],
    ["function", "<top level>", 0, 1],
    ["function", "precise", 0, 1],
    ["binding", "n", 1, 0],
  ]);
  const envelope = coverageEnvelope(coverage, { compilerVersion: "test", sourceTexts });
  expect(envelope.tiers?.requests[0]).toMatchObject({ unit: { kind: expect.any(String) } });
  const relative = JSON.parse(JSON.stringify(tiers).replaceAll(repoRoot + "/", "")) as typeof tiers;
  await expect(renderExplainDynamic(relative)).toMatchFileSnapshot(
    "__snapshots__/coverage-explain-dynamic.txt",
  );
  expect(renderExplainDynamic(relative, { query: "Point" })).toContain("class Point");
  expect(renderExplainDynamic(relative, { query: "Point" })).not.toContain("binding n");
  expect(renderExplainDynamic(relative, { query: "nothing" })).toContain(
    "no demoted unit matches 'nothing'",
  );
});

test("CLI: --tier and --explain-dynamic", () => {
  const scriptcCli = join(repoRoot, "packages/cli/src/main.ts");
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-tier-"));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", scriptcCli, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, SCRIPTC_NO_CACHE: "1" },
    });
  try {
    const explained = run(
      "coverage",
      fixture("tier-demotions.ts"),
      "--explain-dynamic",
      "--tier=static-only",
    );
    expect(explained.status).toBe(0);
    expect(explained.stdout).toContain("in dynamic tier     1");
    expect(explained.stdout).toContain("--tier=static-only");
    expect(explained.stdout).toContain("binding n in precise");
    const one = run("coverage", fixture("tier-demotions.ts"), "--explain-dynamic=Point");
    expect(one.stdout).toContain("class Point");
    expect(one.stdout).not.toContain("binding n in precise");
    const bad = run("coverage", fixture("tier-demotions.ts"), "--tier=dynamic-only");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('unknown --tier value "dynamic-only"');
    const misplaced = run("build", fixture("tier-demotions.ts"), "--explain-dynamic");
    expect(misplaced.status).toBe(1);
    expect(misplaced.stderr).toContain("--explain-dynamic is a coverage option");
    // Until demotion lands, static-only compiles exactly like the default.
    const ir = (name: string, ...args: string[]) => {
      const out = join(outDir, name);
      const built = run(
        "build",
        join(repoRoot, "tests/corpus/400-fib.ts"),
        "--emit=ir",
        "-o",
        out,
        ...args,
      );
      expect(built.status).toBe(0);
      return readFileSync(out, "utf8");
    };
    expect(ir("static-only.ir.json", "--tier=static-only")).toBe(ir("auto.ir.json"));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("fully static program reports 100%", () => {
  const out = report(join(repoRoot, "tests/corpus/400-fib.ts"));
  expect(out).toContain("(100%)");
  expect(out).toContain("fully static");
});

test("fully static JavaScript program reports 100%", () => {
  const out = report(join(repoRoot, "tests/corpus/1590-js-unannotated.js"));
  expect(out).toContain("(100%)");
  expect(out).toContain("fully static");
});

test.each(["3062-runtime-optional-record-guards.ts", "3063-runtime-optional-class-guards.ts"])(
  "runtime-optional guard receivers stay static: %s",
  (name) => {
    {
      const { coverage } = analyze(join(repoRoot, "tests/corpus", name), {});
      expect(coverage.preflightFailed).toBe(false);
      expect(coverage.diagnostics).toEqual([]);
      expect(coverage.stats.statementsFailed).toBe(0);
    }
  },
);

test("coverage preserves function-local class capture environments", () => {
  const { coverage } = analyze(join(repoRoot, "tests/corpus/local-class-unknown.ts"));
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.stats.statementsFailed).toBe(0);
  expect(coverage.unreached?.diagnostics ?? []).toEqual([]);
});

test("module stream aliases remain static in separately declared functions", () => {
  const { coverage } = analyze(join(repoRoot, "tests/corpus/stdio-write-errors.mjs"));
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.runtimeFences ?? []).toEqual([]);
  expect(coverage.stats.statementsFailed).toBe(0);
});

test("runtime-optional refined unions report blockers without crashing", () => {
  {
    const { coverage } = analyze(
      join(repoRoot, "tests/diagnostics/runtime-optional-refined-union.ts"),
      {},
    );
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics.map((d) => d.code)).toEqual(["SC1090"]);
    expect(coverage.stats.statementsFailed).toBe(1);
  }
});

test("a rejected class reached only through a receiver probe reports its own diagnostic once", () => {
  const { coverage } = analyze(join(repoRoot, "tests/diagnostics/deferred-class-receiver/main.ts"));
  const messages = coverage.diagnostics.map((d) => d.message);
  expect(
    messages.filter((m) => m.startsWith("'MapIterator<string>'-typed class fields")),
  ).toHaveLength(1);
  expect(messages.some((m) => m.startsWith("constructing through a class value"))).toBe(true);
  expect(coverage.unreached?.diagnostics ?? []).toEqual([]);
});

test("settled generic rest-order fences count each source statement once", () => {
  const { coverage } = analyze(join(repoRoot, "tests/diagnostics/retained-generic-rest-order.ts"));
  expect(coverage.diagnostics.map((d) => d.code)).toEqual(["SC1031", "SC2004"]);
  expect(coverage.stats.statementsFailed).toBe(2);
});

test("inferred JavaScript compiles natively", async () => {
  // The js-gap fixture turns noImplicitAny off. Its inferred parameter
  // uses checked native values alongside the JSDoc-typed neighbor.
  await expect(report(fixture("js-gap/gap.js"))).toMatchFileSnapshot(
    "__snapshots__/coverage-js-gap.txt",
  );
});

test("JavaScript builtin aliases keep their deferred value fence", async () => {
  await expect(report(fixture("js-builtin-callable-alias.js"))).toMatchFileSnapshot(
    "__snapshots__/coverage-js-builtin-callable-alias.txt",
  );
});

test("types only a package's .d.ts declares stay static through re-exports and .mjs entries", () => {
  // shape-kinds re-exports types its .d.ts entry imports; row-module's
  // runtime entry is an .mjs file. Without their declared types the
  // program's uses of Form, Kind and Row run in the dynamic tier (12
  // statements); with them only the packages' own JavaScript does (3).
  // readRows's result keeps its declared number type, so `count - 1` is
  // native arithmetic too.
  const { coverage } = analyze(
    join(repoRoot, "tests/corpus/7004-package-declared-type-reexports/main.ts"),
  );
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.stats.statementsDynamic).toBe(3);
});

test("any-typed checked-dynamic operators compile natively", () => {
  const file = join(repoRoot, "tests/corpus/2856-dynamic-any-local-operators.ts");
  const staticCoverage = analyze(file).coverage;
  expect(staticCoverage.diagnostics).toEqual([]);
  expect(staticCoverage.stats.statementsFailed).toBe(0);
});

test("npm packages compile by default", async () => {
  // Every site of a package-declared value groups into one SC2013 line
  // naming the package ("values from the 'mathkit' package ..."), inside

  // the two views of the same program stay in sync.
  await expect(
    report(join(repoRoot, "tests/corpus/native-npm-imports/main.ts")),
  ).toMatchFileSnapshot("__snapshots__/coverage-npm-packages.txt");
});

test("import fences no longer stop analysis: percentage plus module blockers", async () => {
  // The fenced module reports ONE grouped blocker (the import line plus
  // every use of its bindings carry the same message); the rest of the
  // program still counts. Lives in the node-types fixture: builtin
  // specifiers only RESOLVE (typecheck) with @types/node adopted — the
  // fallback world turns them into tsc errors, which stay fatal. The same
  // file must FAIL a build (compile() keeps preflight fatal).
  await expect(
    report(join(repoRoot, "tests/fixtures/node-types/import-fences.ts")),
  ).toMatchFileSnapshot("__snapshots__/coverage-import-fences.txt");
});

test("external host declarations unblock application coverage without inventing runtime semantics", () => {
  const root = fixture("external-types");
  const entry = join(root, "main.ts");
  const externalTypes = { "@native-sdk/core": join(root, "native-sdk-core.d.ts") };

  const unmapped = analyze(entry).coverage;
  expect(unmapped.preflightFailed).toBe(true);
  expect(
    unmapped.diagnostics.some((d) => d.code === "SC0001" && d.message.includes("@native-sdk/core")),
  ).toBe(true);

  const { coverage } = analyze(entry, { externalTypes });
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.stats.statementsTotal).toBeGreaterThan(0);
  expect(coverage.diagnostics.some((d) => d.code === "SC0001")).toBe(false);
  expect(
    coverage.diagnostics.some(
      (d) =>
        d.code === "SC1010" &&
        d.message.includes("external host module") &&
        d.message.includes("--external-types"),
    ),
  ).toBe(true);
  const out = renderCoverage({
    ...coverage,
    file: "tests/coverage-fixtures/external-types/main.ts",
  });
  expect(out).toContain("statements analyzed");
  expect(out).toContain("@native-sdk/core");
});

test("external declaration barrels leave type-only local code fully analyzable", () => {
  const root = fixture("external-types");
  const { coverage } = analyze(join(root, "type-only.ts"), {
    externalTypes: { "@native-sdk/core": join(root, "native-sdk-core.d.ts") },
  });
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.stats.statementsFailed).toBe(0);
});

test("external host mappings fence dynamic imports", () => {
  const root = fixture("external-types");
  const { coverage } = analyze(join(root, "dynamic.ts"), {
    externalTypes: { "@native-sdk/core": join(root, "native-sdk-core.d.ts") },
  });
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.stats.statementsFailed).toBeGreaterThan(0);
  expect(
    coverage.diagnostics.some(
      (d) =>
        d.code === "SC1010" &&
        d.message.includes("@native-sdk/core") &&
        d.message.includes("--external-types"),
    ),
  ).toBe(true);
});

test("external host mappings fence side-effect CommonJS requires", () => {
  const root = fixture("external-types");
  const { coverage } = analyze(join(root, "side-effect.cjs"), {
    externalTypes: { "@native-sdk/core": join(root, "native-sdk-core.d.ts") },
  });
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.stats.statementsFailed).toBeGreaterThan(0);
  const blockers = [...coverage.diagnostics, ...(coverage.runtimeFences ?? [])];
  expect(
    blockers.some(
      (d) =>
        d.code === "SC1010" &&
        d.message.includes("@native-sdk/core") &&
        d.message.includes("external host module"),
    ),
  ).toBe(true);
});

test("shared external declarations retain the specifier selected by each local facade", () => {
  const root = fixture("external-types");
  const declaration = join(root, "native-sdk-core.d.ts");
  const { coverage } = analyze(join(root, "facade-consumer.ts"), {
    externalTypes: {
      "@native-sdk/core": declaration,
      "@native-sdk/unused": declaration,
    },
  });
  expect(coverage.preflightFailed).toBe(false);
  const valueBlockers = coverage.diagnostics.filter(
    (d) => d.code === "SC1010" && d.message.startsWith("values from"),
  );
  expect(valueBlockers.some((d) => d.message.includes("@native-sdk/core"))).toBe(true);
  expect(valueBlockers.some((d) => d.message.includes("@native-sdk/unused"))).toBe(true);
});

test("external star facades do not claim local exports", () => {
  const root = fixture("external-types");
  const { coverage } = analyze(join(root, "mixed-star-consumer.ts"), {
    externalTypes: { "@native-sdk/core": join(root, "native-sdk-core.d.ts") },
  });
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.stats.statementsTotal).toBe(2);
  expect(coverage.stats.statementsFailed).toBe(0);
  expect(
    coverage.diagnostics.some(
      (d) =>
        d.code === "SC1010" && d.message.includes("the '@native-sdk/core' external host module"),
    ),
  ).toBe(true);
  expect(
    coverage.diagnostics.some((d) => d.code === "SC1010" && d.message.startsWith("values from")),
  ).toBe(false);
});

test("external host mappings take precedence over overlapping npm-static packages", () => {
  const root = fixture("external-types");
  const entry = join(repoRoot, "tests/fixtures/npm-static/slash-cli.ts");
  const { coverage } = analyze(entry, {
    npmStatic: ["slash"],
    externalTypes: { slash: join(root, "slash-host.d.ts") },
  });
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.npmStatic).toEqual([
    {
      package: "slash",
      status: "refused",
      detail: 'mapped as an external host module by --external-types ("slash")',
    },
  ]);
  expect(coverage.diagnostics.some((d) => d.code === "SC2013")).toBe(false);
  expect(
    coverage.diagnostics.some((d) => d.code === "SC1010" && d.message.includes("'slash'")),
  ).toBe(true);
});

test("CLI accepts repeatable --external-types mappings for coverage", () => {
  const root = fixture("external-types");
  const scriptcCli = join(repoRoot, "packages/cli/src/main.ts");
  const out = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      scriptcCli,
      "coverage",
      join(root, "main.ts"),
      "--external-types",
      `@native-sdk/core=${join(root, "native-sdk-core.d.ts")}`,
      "--external-types",
      `@native-sdk/unused=${join(root, "native-sdk-core.d.ts")}`,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  expect(out).toContain("statements analyzed");
  expect(out).toContain("@native-sdk/core");
  expect(out).not.toContain("Cannot find module");
});

test("external type mappings reject TypeScript paths patterns", () => {
  const root = fixture("external-types");
  const entry = join(root, "type-only.ts");
  const declaration = join(root, "native-sdk-core.d.ts");
  expect(() => analyze(entry, { externalTypes: { "@native-sdk/*": declaration } })).toThrow(
    "expected an exact bare package specifier",
  );

  const scriptcCli = join(repoRoot, "packages/cli/src/main.ts");
  const cli = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      scriptcCli,
      "coverage",
      entry,
      "--external-types",
      `@native-sdk/*=${declaration}`,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  expect(cli.status).toBe(1);
  expect(cli.stderr).toContain("expected an exact bare package specifier");
});

test("external type mappings reject non-declaration and unreadable API paths", () => {
  const root = fixture("external-types");
  const entry = join(root, "type-only.ts");
  expect(() =>
    analyze(entry, { externalTypes: { "@native-sdk/core": join(root, "main.ts") } }),
  ).toThrow("expected a .d.ts, .d.mts, or .d.cts file");
  expect(() =>
    analyze(entry, { externalTypes: { "@native-sdk/core": join(root, "missing.d.ts") } }),
  ).toThrow("does not name a readable file");
});

test("type errors block analysis", () => {
  const out = report(fixture("type-errors.ts"));
  expect(out).toContain("not analyzable");
  expect(out).toContain("1 TypeScript error");
});

test("type errors render the same code frame a build prints", () => {
  const { coverage, sourceTexts } = analyze(fixture("type-errors.ts"));
  const out = renderCoverage(coverage, { sourceTexts });
  expect(out).toContain("not analyzable");
  expect(out).toContain("error SC0001");
  // The frame gutter with the offending line, exactly the build renderer.
  expect(out).toMatch(/\d+ \| /);
  expect(out).toContain("^");
});

test("bare '.' and '..' imports are relative edges (the vercel-CLI dialect)", () => {
  // `from '..'` / `from '.'` resolve as directory imports to the target's
  // index module — exactly what the project's bundler-resolution checker
  // answered — so the graph loads and everything compiles statically.
  const out = report(fixture("dot-parent/main.ts"));
  expect(out).toContain("(100%)");
  expect(out).toContain("fully static");
});

test("a cycle whose top level calls a builtin with a builtin function value is admitted", () => {
  // vercel's link.ts cluster: `promisify(fs.readFile)` at a cycle member's
  // top level. Callee and callable argument are both dts-rooted — no user
  // code can run in the init window — so no SC1016 and the analysis
  // renders statement counts (the statement itself may stay a
  // statement-LEVEL blocker; that is a different fence).
  const out = report(fixture("cycle-inert-builtin/main.ts"));
  expect(out).not.toContain("circular imports");
  expect(out).toContain("statements analyzed");
});

test("Node islands (report-only): one package per class, gap islands first", async () => {
  // ni-gap (a fence inside the native subset), ni-eval (new Function),
  // ni-ctor (a constructor function, carrying ni-dep), ni-bundled (not
  // compilable as shipped), ni-typed (native, also reached from ni-ctor).
  const entry = fixture("node-islands/main.ts");
  await expect(report(entry)).toMatchFileSnapshot("__snapshots__/coverage-node-islands.txt");
  const { coverage, sourceTexts } = analyze(entry);
  const islands = coverage.nodeIslands!;
  expect(islands.islands.map((i) => [i.package, i.class])).toEqual([
    ["ni-gap", "gap"],
    ["ni-eval", "runtime"],
    ["ni-ctor", "object-model"],
    ["ni-bundled", "packaging"],
  ]);
  expect(islands.packages.map((p) => [p.package, p.status, p.islands])).toEqual([
    ["ni-dep", "inside", ["ni-ctor"]],
    ["ni-typed", "shared", ["ni-ctor"]],
  ]);
  await expect(
    renderExplainIsland(coverage.nodeIslands, "ni-ctor", { sourceTexts, root: repoRoot }),
  ).toMatchFileSnapshot("__snapshots__/coverage-node-islands-explain.txt");
  expect(renderExplainIsland(coverage.nodeIslands, "ni-dep", { root: repoRoot })).toContain(
    "only ni-ctor imports it",
  );
  // The machine-readable form carries the same decisions.
  const envelope = coverageEnvelope(coverage, { compilerVersion: "test", sourceTexts });
  expect(envelope.nodeIslands?.mode).toBe("would-be");
  expect(envelope.nodeIslands?.islands.map((i) => [i.package, i.class, i.at?.line])).toEqual([
    ["ni-gap", "gap", 7],
    ["ni-eval", "runtime", 4],
    ["ni-ctor", "object-model", 9],
    ["ni-bundled", "packaging", undefined],
  ]);
  // The gates: the blocker gate is today's build (which refuses
  // ni-bundled with SC2013, and nothing else); the island gates fail on
  // the would-be islands.
  expect(coverage.diagnostics.every((d) => d.code === "SC2013")).toBe(true);
  expect(coveragePasses(coverage, "island-gaps")).toBe(false);
  expect(coveragePasses(coverage, "node-islands")).toBe(false);
});

test("unknown scriptc settings warn in a build and make the island report unavailable", async () => {
  const entry = fixture("node-islands-config/main.ts");
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-island-config-"));
  try {
    const built = await compile(entry, {
      outputKind: "ir",
      outPath: join(outDir, "main.ir.json"),
      outDir,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect((built.warnings ?? []).map((d) => [d.code, d.message])).toEqual([
      ["SC8004", `package.json 'scriptc.packages.encoding' has the unknown value "unloded"`],
      ["SC8004", `package.json 'scriptc.packages.debug.run' has the unknown value "island"`],
      ["SC8004", `package.json 'scriptc.nodeIslands.auto' must be true or false, not "yes"`],
      ["SC8004", "package.json 'scriptc.nodeIslands.mode' is not a known Node island setting"],
    ]);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
  const { coverage } = analyze(entry);
  expect(coverage.nodeIslands).toBeUndefined();
  expect(renderCoverage({ ...coverage, file: "main.ts" }, { root: repoRoot })).toContain(
    "not analyzable: the project's scriptc configuration has 4 unknown settings",
  );
});

test("Node island policy from the command line: native, forced, off", () => {
  const entry = fixture("node-islands/main.ts");
  const forced = analyze(entry, {
    nodeIslands: { native: ["ni-eval"], islands: ["ni-typed", "not-a-dependency"] },
  }).coverage.nodeIslands!;
  expect(forced.islands.map((i) => [i.package, i.class, i.decision])).toEqual([
    ["ni-gap", "gap", "auto"],
    ["ni-ctor", "object-model", "auto"],
    ["ni-bundled", "packaging", "auto"],
    ["ni-typed", "marked", "cli"],
  ]);
  expect(forced.violations.map((v) => v.code)).toEqual(["SC8003"]);
  expect(forced.unknownPackages).toEqual(["not-a-dependency"]);
  const off = analyze(entry, { nodeIslands: { mode: "off" } }).coverage;
  expect(off.nodeIslands!.islands).toEqual([]);
  expect(off.nodeIslands!.violations.map((v) => v.code)).toEqual([
    "SC8002",
    "SC8002",
    "SC8002",
    "SC8002",
  ]);
  expect(coveragePasses(off, "island-gaps")).toBe(false);
});

test("--strict-user-js reports R2 constructs in user JavaScript as SC8101–SC8105", async () => {
  const entry = fixture("node-islands-user-js.cjs");
  // Without the flag the user module is not part of any island report.
  expect(analyze(entry).coverage.nodeIslands).toBeUndefined();
  const { coverage } = analyze(entry, { nodeIslands: { strictUserJs: true } });
  expect(coverage.diagnostics.map((d) => d.code).filter((c) => c.startsWith("SC81"))).toEqual([
    "SC8101",
    "SC8102",
    "SC8103",
    "SC8104",
    "SC8105",
    "SC8101",
  ]);
  await expect(
    renderCoverage(
      { ...coverage, file: coverage.file.replace(repoRoot + "/", "") },
      { root: repoRoot },
    ),
  ).toMatchFileSnapshot("__snapshots__/coverage-node-islands-user-js.txt");
});

test(`every corpus program is 100% static (corpus and coverage agree${shardSuffix()})`, async () => {
  // The differential corpus compiles by definition; coverage must agree.

  // The sweep runs minutes on slow machines and each analyze() blocks the
  // worker thread — without the periodic yield, vitest's worker RPC starves
  // ("Timeout calling onTaskUpdate") even while every check passes, and the
  // default per-test timeout is far too small for a whole-corpus analysis.
  let n = 0;
  const flatEntries = shardSelect(
    ["ts", "js", "mjs", "cjs"]
      .flatMap((ext) => globSync(join(repoRoot, `tests/corpus/*.${ext}`)))
      .sort(),
    (file) => file.slice(repoRoot.length + 1),
  );
  for (const file of flatEntries) {
    const firstLine = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
    // `// @deferred-fences: N` on the first line: a JS program that
    // DELIBERATELY carries N runtime-fence statements on untaken paths
    // (the deferred-fence corpus) — it still passes the differential
    // oracle because the fences never execute.
    const deferred = /^\/\/ @deferred-fences:\s*(\d+)\s*$/.exec(firstLine);
    const { coverage } = analyze(file, {});
    expect.soft(coverage.diagnostics, file).toEqual([]);
    // Corpus programs match Node by definition: a divergence warning on one
    // is a false positive.
    expect.soft(coverage.divergences ?? [], file).toEqual([]);
    expect.soft(coverage.stats.statementsFailed, file).toBe(deferred ? Number(deferred[1]) : 0);
    if (++n % 10 === 0) await new Promise((r) => setImmediate(r));
  }
}, 600_000);
