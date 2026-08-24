/* Project adoption: the tsconfig.json governing the ENTRY decides checker
 * strictness (the adopted knobs), while lib/module/target stay forced —
 * see the compiler-options split in frontend/program.ts and SEMANTICS.md.
 * The strictness fixtures compile the SAME program under two tsconfigs and
 * pin both directions; the null-floor fixture pins the strictNullChecks
 * floor diagnostic; the node-types fixture (vendored, pinned @types/node —
 * see its README) pins the @types/node adoption path: the supported
 * process surface still lowers statically, and everything else @types/node
 * declares fences with the SC2020-family wording that names it.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { analyze, compile, renderDiagnostics } from "@scriptc/compiler";

/* Every compile below deliberately carries NO backend pin: this suite is
 * the user-adoption path, so it must see exactly what a flagless
 * `scriptc build` produces — the LLVM backend where the tier claims the
 * program, the transparent C fallback where it refuses. A failure here
 * that a `backend: "c"` pin would hide is a release-default bug. */
const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixture = (name: string) => join(repoRoot, "tests/fixtures/strictness", name);
const nodeTypesDir = join(repoRoot, "tests/fixtures/node-types");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

function outDirFor(name: string): string {
  return mkdtempSync(join(tmpdir(), `scriptc-config-${name}-`));
}

test("indexed-loose: the project's own (less strict) knobs are adopted — compiles and runs", async () => {
  const outDir = outDirFor("loose");
  const result = await compile(join(fixture("indexed-loose"), "main.ts"), {
    outPath: join(outDir, "main"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout } = await execFileAsync(result.binaryPath);
  expect(stdout).toBe("21\n");
});

test("indexed-strict: the project's EXTRA strictness is honored — preflight fails", async () => {
  const outDir = outDirFor("strict");
  const result = await compile(join(fixture("indexed-strict"), "main.ts"), {
    outPath: join(outDir, "main"),
    outDir,
    sanitize,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  // The SAME program compiles in indexed-loose; only the tsconfig differs.
  expect(result.diagnostics.map((d) => d.code)).toContain("SC0001");
  expect(result.diagnostics.some((d) => d.message.includes("possibly 'undefined'"))).toBe(true);
});

test("node-types: the supported process surface lowers statically under @types/node", async () => {
  const outDir = outDirFor("node-types");
  const result = await compile(join(nodeTypesDir, "argv-env.ts"), {
    outPath: join(outDir, "argv-env"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout } = await execFileAsync(result.binaryPath, ["alpha", "beta"], {
    env: { ...process.env, SCRIPTC_FIXTURE_GREETING: "hi from env" },
  });
  // argv[0] is the binary path (machine-dependent) — the program prints
  // only the count and argv[1..], then exercises the raw stdout write.
  expect(stdout).toBe("2\nalpha\nbeta\nhi from env\nwritten without newline <- flushed in order\n");
});

test("node-types: captured NodeJS.WritableStream values write through the procStream scalar", async () => {
  const outDir = outDirFor("node-stream-capture");
  const result = await compile(join(nodeTypesDir, "stream-capture.ts"), {
    outPath: join(outDir, "stream-capture"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout, stderr } = await execFileAsync(result.binaryPath);
  expect(stdout).toBe("[out] line\n[out] line\ndone\n");
  expect(stderr).toBe("[err] line\n");
});

test("node-types: path and os lower statically under @types/node's shapes", async () => {
  const outDir = outDirFor("node-path-os");
  const result = await compile(join(nodeTypesDir, "path-os.ts"), {
    outPath: join(outDir, "path-os"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout } = await execFileAsync(result.binaryPath);
  expect(stdout).toBe("b/c.txt\n/x/y z .gz\ntrue /\ntrue true\ntrue true true true true\ntrue\n");
});

test("node-types: fetch AbortSignal and readable bodies lower statically", async () => {
  const outDir = outDirFor("node-fetch-static");
  const result = await compile(join(nodeTypesDir, "fetch-static.ts"), {
    outPath: join(outDir, "fetch-static"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
});

test("node-types: declared-but-not-lowered surface fences, naming @types/node", async () => {
  const outDir = outDirFor("node-fenced");
  const result = await compile(join(nodeTypesDir, "fenced.ts"), {
    outPath: join(outDir, "fenced"),
    outDir,
    sanitize,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const rendered = renderDiagnostics(result.diagnostics, result.sourceTexts, { color: false })
    .replaceAll(nodeTypesDir + "/", "");
  await expect(rendered).toMatchFileSnapshot("__snapshots__/node-types-fenced.txt");
});

test("json-any: any-typed JSON.parse reads pass preflight (the project's own tsc is the oracle) and LOWER now; the non-Error reject still fences", async () => {
  const outDir = outDirFor("json-any");
  const entry = join(fixture("json-any"), "main.ts");
  // Analyzable: the program typechecks under its own tsconfig, so the
  // override-manufactured errors (parse(): unknown, reject's pinned
  // `(reason: Error) => void`) never fail preflight — coverage computes
  // instead of stopping.
  const { coverage } = analyze(entry);
  expect(coverage.preflightFailed).toBe(false);
  // The build still fails — at LOWERING, with the honest fence for the
  // string reject (a bound reject called with an Error is the supported
  // surface and lowers). The unknown READS lower now (the dyn keyed read,
  // corpus 1544) — no SC1100 remains. Never a SC0001.
  const result = await compile(entry, {
    outPath: join(outDir, "main"),
    outDir,
    sanitize,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const codes = result.diagnostics.map((d) => d.code);
  expect(codes).not.toContain("SC0001");
  expect(codes).not.toContain("SC1100");
  expect(
    result.diagnostics.some((d) => d.message.includes("'string' values where 'Error' is expected")),
  ).toBe(true);
});

test("json-any-broken: genuine type errors report the project world's own tsc errors, not override-manufactured ones", async () => {
  const outDir = outDirFor("json-any-broken");
  const result = await compile(join(fixture("json-any-broken"), "main.ts"), {
    outPath: join(outDir, "main"),
    outDir,
    sanitize,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const tsc = result.diagnostics.filter((d) => d.code === "SC0001");
  expect(tsc.some((d) => d.message.includes("is not assignable to type 'number'"))).toBe(true);
  // The 'unknown' complaint exists only in the lowering world — the
  // reported set is the project world's, reproducible with their own tsc.
  expect(tsc.some((d) => d.message.includes("'unknown'"))).toBe(false);
});

test("null-floor: disabling strictNullChecks fails with the floor diagnostic", async () => {
  const outDir = outDirFor("floor");
  const result = await compile(join(fixture("null-floor"), "main.ts"), {
    outPath: join(outDir, "main"),
    outDir,
    sanitize,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((d) => d.code)).toContain("SC0002");
  expect(result.diagnostics[0]!.message).toContain("strictNullChecks");
});

test("no-types-node: a bare project outside the repo compiles on the fallback declarations", async () => {
  // The npm-install shape: a fresh directory whose package.json has no
  // "type" and whose node_modules has no @types/node — the shipped
  // fallback d.ts is the whole Node surface. Regression: tsgo treats a
  // d.ts under a type:module package as ESM and bans its `export =`
  // ambient-module blocks (9× SC0001 at 1:1); ambient/package.json pins
  // the realm to commonjs so the fallback stays a legal global script.
  const dir = mkdtempSync(join(tmpdir(), "scriptc-bare-project-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "bare", version: "1.0.0" }));
  writeFileSync(join(dir, "main.ts"), 'const who: string = "bare";\nconsole.log(`hi ${who}`);\n');
  const outDir = outDirFor("bare");
  const result = await compile(join(dir, "main.ts"), {
    outPath: join(outDir, "main"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout } = await execFileAsync(result.binaryPath);
  expect(stdout).toBe("hi bare\n");
});

test("dot-parent: bare '.' and '..' imports build and run (the TS project dialect)", async () => {
  // The vercel-CLI spelling (`from '..'` for a parent directory's index):
  // scriptc-only — Node refuses directory imports when running raw TS as
  // ESM, but the compiled program follows the project's own bundler-
  // resolution dialect (the SEMANTICS.md relative-specifier note).
  const outDir = outDirFor("dot-parent");
  const result = await compile(join(repoRoot, "tests/coverage-fixtures/dot-parent/main.ts"), {
    outPath: join(outDir, "main"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout } = await execFileAsync(result.binaryPath);
  expect(stdout).toBe("parent-banner:lib-index!\n");
});
