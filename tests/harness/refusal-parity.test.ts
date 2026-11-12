/* The Node.js load hook refuses what a scriptc build refuses, with the same
 * code and message. This runs each refusal probe twice: under
 * `node --require @scriptc/experimental/register` (and with `--import`), and
 * through the compiler, and compares the two answers.
 *
 * The rows come from packages/experimental/refusals.json, the file the
 * preload indexes, so a row that the hook and the compiler disagree on fails
 * here rather than reaching a user.
 *
 * A module row and a native addon row are build failures: the compiler
 * refuses the program before code generation, so there is no binary to run,
 * and the compiler's side of the comparison is analyze()'s diagnostic for the
 * same probe program. A process.getBuiltinModule call compiles and throws at
 * runtime, so its compiler side is the built binary itself.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "@scriptc/compiler";
import { spawnResult } from "./spawn-result.js";

const repoRoot = join(import.meta.dirname, "../..");
const registerPath = join(repoRoot, "packages/experimental/register.js");
const refusalsPath = join(repoRoot, "packages/experimental/refusals.json");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/refusal-parity");

/** One row of the refusal data. Only the load-layer rows are the hook's. */
interface RefusalRow {
  binding: { module: string; access: string };
  code: string;
  message: string;
  layer: string;
}

const rows: RefusalRow[] = JSON.parse(readFileSync(refusalsPath, "utf8")).refusals;

/** The load-layer rows the preload indexes, one per module, first row wins
 * (register.js keeps the first). Rows with another access belong to the
 * checks that read a binding, not to the hook. */
const expected = new Map<string, RefusalRow>();
for (const row of rows) {
  if (row.layer !== "load" || row.binding?.access !== "import") continue;
  const specifier = row.binding.module;
  if (typeof specifier !== "string" || typeof row.code !== "string") continue;
  if (!expected.has(specifier)) expected.set(specifier, row);
}

/** A probe directory keyed by its contents, so a re-run compiles from the
 * executable cache instead of rebuilding. */
function probeDir(key: string, source: string): string {
  const digest = createHash("sha256").update(`${key}\0${source}`).digest("hex").slice(0, 16);
  const dir = join(cacheDir, digest);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Runs a script under the preload with the given loader flag, returning
 * stdout. */
async function runWithHook(
  flag: "--require" | "--import",
  args: readonly string[],
  cwd: string,
): Promise<string> {
  const result = await spawnResult(process.execPath, [flag, registerPath, ...args], {
    cwd,
    timeout: 120_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result.stdout.toString();
}

/** Runs the built binary, returning stdout. */
async function runBinary(path: string, cwd: string): Promise<string> {
  const result = await spawnResult(path, [], { cwd, timeout: 120_000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result.stdout.toString();
}

/** Each probe prints one `specifier<TAB>code<TAB>message` line per refusal. */
function refusalLines(stdout: string): string[] {
  return stdout.trimEnd().split("\n");
}

test("Refuses every load-layer module with the compiler's code and message", async () => {
  expect(expected.size).toBeGreaterThan(0);
  const specifiers = [...expected.keys()];

  const dir = join(cacheDir, "driver");
  mkdirSync(dir, { recursive: true });
  const listPath = join(dir, "specifiers.json");
  writeFileSync(listPath, JSON.stringify(specifiers));
  const driverPath = join(dir, "driver.mjs");
  writeFileSync(
    driverPath,
    `import { readFileSync } from "node:fs";
const specifiers = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const specifier of specifiers) {
  try {
    await import(specifier);
    console.log(specifier + "\\tallowed");
  } catch (error) {
    console.log(specifier + "\\t" + error.code + "\\t" + error.message);
  }
}
`,
  );

  const wanted = specifiers.map(
    (specifier) =>
      `${specifier}\t${expected.get(specifier)!.code}\t${expected.get(specifier)!.message}`,
  );
  for (const flag of ["--require", "--import"] as const) {
    const stdout = await runWithHook(flag, [driverPath, listPath], dir);
    expect(refusalLines(stdout), flag).toEqual(wanted);
  }

  // The compiler's side of the same program: one side-effect import per
  // module. analyze() rather than compile(), because the build stops before
  // code generation and so has no binary to run.
  const source = `${specifiers.map((specifier) => `import ${JSON.stringify(specifier)};\n`).join("")}`;
  const probe = probeDir("modules", source);
  const probePath = join(probe, "modules.ts");
  writeFileSync(probePath, source);
  const diagnostics = analyze(probePath).coverage.diagnostics;
  for (const specifier of specifiers) {
    const row = expected.get(specifier)!;
    const diagnostic = diagnostics.find(
      (candidate) => candidate.code === row.code && candidate.message === row.message,
    );
    expect(
      diagnostic,
      `the compiler reports ${specifier} the way the hook does: ${row.code} ${row.message} (got ${diagnostics
        .map((candidate) => `${candidate.code} ${candidate.message}`)
        .join("; ")})`,
    ).toBeDefined();
  }
});

test("Refuses a native addon with the compiler's code and message", async () => {
  // The same program twice: Node runs the .mjs form, which has no types
  // (Node strips none for files under node_modules, where the cache lives),
  // and analyze() reads the .ts form, whose cast over the catch variable
  // keeps the type checker from stopping the analysis before the require.
  const probeSource = (catchBody: string) => `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
try {
  require("./addon.node");
  console.log("allowed");
} catch (error) {
  ${catchBody}
}
`;
  const runSource = probeSource(`console.log(error.code + "\\t" + error.message);`);
  const analyzeSource = probeSource(
    `const failure = error as { code?: string; message?: string };
  console.log(failure.code + "\\t" + failure.message);`,
  );
  const dir = probeDir("addon", runSource);
  const runPath = join(dir, "addon.mjs");
  writeFileSync(runPath, runSource);
  const probePath = join(dir, "addon.ts");
  writeFileSync(probePath, analyzeSource);
  writeFileSync(join(dir, "addon.node"), "");

  const stdout = await runWithHook("--require", [runPath], dir);
  const lines = refusalLines(stdout);
  expect(lines).toHaveLength(1);
  const [code, message] = lines[0]!.split("\t");
  expect(code).toBe("SC2020");
  expect(message).toContain("addon.node");

  const diagnostics = analyze(probePath).coverage.diagnostics;
  expect(
    diagnostics.some((candidate) => candidate.code === code && candidate.message === message),
    `the compiler reports the addon the way the hook does: ${code} ${message} (got ${diagnostics
      .map((candidate) => `${candidate.code} ${candidate.message}`)
      .join("; ")})`,
  ).toBe(true);
});

test("Refuses process.getBuiltinModule the way a built binary does", async () => {
  const refused = [...expected.keys()].filter((specifier) => specifier.startsWith("node:"));
  expect(refused.length).toBeGreaterThan(0);
  const ids = refused.slice(0, 2);

  const calls = ids
    .map(
      (id) => `try {
  process.getBuiltinModule(${JSON.stringify(id)});
  console.log(${JSON.stringify(id)} + "\\tallowed");
} catch (error) {
  console.log(${JSON.stringify(id)} + "\\t" + error.code + "\\t" + error.message);
}
`,
    )
    .join("");
  const source = `${calls}`;
  const dir = probeDir("get-builtin-module", source);
  const probePath = join(dir, "get-builtin-module.mjs");
  writeFileSync(probePath, source);

  const underHook = await runWithHook("--require", [probePath], dir);

  // Not a sanitized build: this compares refusal text, and the getBuiltinModule
  // throw is the same code either way. The corpus carries the sanitizer runs.
  const built = await compile(probePath, {
    outPath: join(dir, "get-builtin-module"),
    outDir: dir,
    backend: "llvm",
  });
  if (!built.ok)
    throw new Error(
      built.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("\n"),
    );
  const fromBinary = await runBinary(join(dir, "get-builtin-module"), dir);

  expect(refusalLines(fromBinary)).toEqual(refusalLines(underHook));
  expect(refusalLines(underHook)).toHaveLength(ids.length);
  for (const line of refusalLines(underHook)) expect(line).toContain("\tSC2020\t");
});

test("Leaves supported builtin modules loadable", async () => {
  const dir = join(cacheDir, "supported");
  mkdirSync(dir, { recursive: true });
  const driverPath = join(dir, "driver.mjs");
  writeFileSync(
    driverPath,
    `import { existsSync } from "node:fs";
import { join } from "node:path";
console.log(existsSync(join(".")) ? "loadable" : "missing");
`,
  );
  expect(await runWithHook("--require", [driverPath], dir)).toBe("loadable\n");
});
