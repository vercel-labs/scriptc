import { execFileSync, spawnSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, coverageEnvelope, coveragePasses, renderCoverage } from "@scriptc/compiler";
import { shardSelect, shardSuffix } from "./shard.js";

const repoRoot = join(import.meta.dirname, "../..");
const fixture = (name: string) => join(repoRoot, "tests/coverage-fixtures", name);

function report(path: string, opts: { dynamic?: boolean } = {}): string {
  const { coverage } = analyze(path, opts);
  return renderCoverage(
    { ...coverage, file: coverage.file.replace(repoRoot + "/", "") },
    { root: repoRoot },
  );
}

test("mixed program: percentage and grouped blockers", async () => {
  await expect(report(fixture("mixed.ts"))).toMatchFileSnapshot("__snapshots__/coverage-mixed.txt");
});

test("dynamic-capable blockers split from static rejections", async () => {
  // SC2010/SC2011/SC2012 sites group under "runs with --dynamic";
  // constructs no flag fixes stay under "blockers".
  await expect(report(fixture("dynamic-mix.ts"))).toMatchFileSnapshot(
    "__snapshots__/coverage-dynamic-mix.txt",
  );
});

test("--dynamic analysis: island sites count as compiled-dynamically", async () => {
  // The same fixture analyzed as a --dynamic build: the island-capable
  // sites LOWER (splitting out of "compile statically" into "compile
  // dynamically") and only the flag-independent rejections remain
  // blockers — this report is the "distance to a working build" view.
  await expect(report(fixture("dynamic-mix.ts"), { dynamic: true })).toMatchFileSnapshot(
    "__snapshots__/coverage-dynamic-mix-dynamic.txt",
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

test("divergences report as warnings, never as blockers", async () => {
  const { coverage } = analyze(fixture("divergences.ts"));
  expect(coverage.diagnostics).toEqual([]);
  expect((coverage.divergences ?? []).map((d) => d.code)).toEqual([
    "SC6001",
    "SC6001",
    "SC6002",
    "SC6003",
    "SC6004",
    "SC6005",
    "SC6005",
    "SC6005",
  ]);
  expect(coveragePasses(coverage, "blockers")).toBe(true);
  expect(coveragePasses(coverage, "divergences")).toBe(false);
  await expect(report(fixture("divergences.ts"))).toMatchFileSnapshot(
    "__snapshots__/coverage-divergences.txt",
  );
});

test("ordinary code reports no divergence", () => {
  const { coverage } = analyze(fixture("no-divergences.ts"));
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.divergences ?? []).toEqual([]);
});

test("statements of a signature-blocked function count as not static", () => {
  const { coverage } = analyze(fixture("blocked-signature.ts"));
  const un = coverage.unreached?.stats;
  expect(coverage.stats.functionsSkipped + (un?.functionsSkipped ?? 0)).toBe(1);
  // Two top-level statements plus the four the blocked body holds.
  expect(coverage.stats.statementsTotal + (un?.statementsTotal ?? 0)).toBe(6);
  expect(coverage.stats.statementsFailed + (un?.statementsFailed ?? 0)).toBe(5);
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
    [
      "SC2012",
      "'parseFloat' with a 'boolean' argument (only a string argument compiles statically) runs in the embedded dynamic engine, which this build does not include",
    ],
    [
      "SC2012",
      "'Number.parseInt' with a 'number' argument (only a string argument compiles statically) runs in the embedded dynamic engine, which this build does not include",
    ],
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
    expect(envelope.diagnostics.map((d) => d.severity)).toEqual(Array(8).fill("warning"));
    const human = build(fixture("divergences.ts"));
    expect(human.status).toBe(0);
    expect(human.stderr).toContain("warning SC6001");
    expect(human.stderr).toContain("8 warnings: the program compiled");
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
    for (const dynamic of [false, true]) {
      const { coverage } = analyze(join(repoRoot, "tests/corpus", name), { dynamic });
      expect(coverage.preflightFailed).toBe(false);
      expect(coverage.diagnostics).toEqual([]);
      expect(coverage.stats.statementsFailed).toBe(0);
      expect(coverage.stats.statementsIsland).toBe(0);
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
  for (const dynamic of [false, true]) {
    const { coverage } = analyze(
      join(repoRoot, "tests/diagnostics/runtime-optional-refined-union.ts"),
      { dynamic },
    );
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics.map((d) => d.code)).toEqual(["SC1090"]);
    expect(coverage.stats.statementsFailed).toBe(1);
  }
});

test("settled generic rest-order fences count each source statement once", () => {
  const { coverage } = analyze(join(repoRoot, "tests/diagnostics/retained-generic-rest-order.ts"));
  expect(coverage.diagnostics.map((d) => d.code)).toEqual(["SC1031", "SC2004"]);
  expect(coverage.stats.statementsFailed).toBe(2);
});

test("inferred JavaScript stays static with or without the island enabled", async () => {
  // The js-gap fixture turns noImplicitAny off. Its inferred parameter
  // uses checked native values alongside the JSDoc-typed neighbor.
  await expect(report(fixture("js-gap/gap.js"))).toMatchFileSnapshot(
    "__snapshots__/coverage-js-gap.txt",
  );
  await expect(report(fixture("js-gap/gap.js"), { dynamic: true })).toMatchFileSnapshot(
    "__snapshots__/coverage-js-gap-dynamic.txt",
  );
});

test("JavaScript builtin aliases keep their deferred value fence", async () => {
  await expect(report(fixture("js-builtin-callable-alias.js"))).toMatchFileSnapshot(
    "__snapshots__/coverage-js-builtin-callable-alias.txt",
  );
});

test("any-typed checked-dynamic operators compile in both tiers", () => {
  const file = join(repoRoot, "tests/corpus/2856-dynamic-any-local-operators.ts");
  const staticCoverage = analyze(file).coverage;
  expect(staticCoverage.diagnostics).toEqual([]);
  expect(staticCoverage.stats.statementsFailed).toBe(0);
  expect(staticCoverage.stats.statementsIsland).toBe(0);

  const dynamicCoverage = analyze(file, { dynamic: true }).coverage;
  expect(dynamicCoverage.diagnostics).toEqual([]);
  expect(dynamicCoverage.stats.statementsFailed).toBe(0);
  expect(dynamicCoverage.stats.statementsIsland).toBeGreaterThan(0);
});

test("npm package sites attribute per package", async () => {
  // Every site of a package-declared value groups into one SC2013 line
  // naming the package ("values from the 'mathkit' package ..."), inside
  // the "runs with --dynamic" group — reusing the diagnostics fixture so
  // the two views of the same program stay in sync.
  await expect(report(join(repoRoot, "tests/diagnostics/npm-imports/main.ts"))).toMatchFileSnapshot(
    "__snapshots__/coverage-npm-packages.txt",
  );
});

test("lazy edges inventory: unresolvable require()/import() targets mark as lazy traps", async () => {
  // The lazy-traps npm fixture builds (Node's per-kind edge semantics:
  // require fails at the call, import() at evaluation) — the coverage
  // table lists every blocked-but-lazy specifier with the lazy-trap
  // marker instead of reporting SC2030 blockers.
  await expect(
    report(join(repoRoot, "tests/fixtures/npm/cases/lazy-traps/main.ts"), { dynamic: true }),
  ).toMatchFileSnapshot("__snapshots__/coverage-npm-lazy-traps.txt");
});

test("lazy builtin edges mark in the builtins table, __require sites included", async () => {
  // The esbuild-require fixture routes external requires through the
  // bundle's __require helper — its literal call sites collect as require
  // edges, so the builtins table lists node:os/node:tty (shimmed) and
  // node:stream as a lazy trap (unshimmed, reached only by the
  // never-called require) without failing the build.
  await expect(
    report(join(repoRoot, "tests/fixtures/npm/cases/esbuild-require/main.ts"), { dynamic: true }),
  ).toMatchFileSnapshot("__snapshots__/coverage-npm-lazy-builtin.txt");
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

test("external host mappings fence dynamic imports even with the island enabled", () => {
  const root = fixture("external-types");
  const { coverage } = analyze(join(root, "dynamic.ts"), {
    dynamic: true,
    externalTypes: { "@native-sdk/core": join(root, "native-sdk-core.d.ts") },
  });
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.stats.statementsFailed).toBeGreaterThan(0);
  expect(coverage.stats.statementsIsland).toBe(0);
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
      status: "fallback",
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

test(`every corpus program is 100% static (corpus and coverage agree${shardSuffix()})`, async () => {
  // The differential corpus compiles by definition; coverage must agree.
  // `// @dynamic` programs compile under --dynamic, so analyze them that way.
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
    const { coverage } = analyze(file, { dynamic: /^\/\/ @dynamic\s*$/.test(firstLine) });
    expect.soft(coverage.diagnostics, file).toEqual([]);
    // Corpus programs match Node by definition: a divergence warning on one
    // is a false positive.
    expect.soft(coverage.divergences ?? [], file).toEqual([]);
    expect.soft(coverage.stats.statementsFailed, file).toBe(deferred ? Number(deferred[1]) : 0);
    if (++n % 10 === 0) await new Promise((r) => setImmediate(r));
  }
}, 600_000);
