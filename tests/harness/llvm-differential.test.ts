/* Both LLVM optimization modes must compile every corpus program and match
 * Node's stdout, successful stderr, and expected exit status. Any backend
 * refusal is a failure. SCRIPTC_SAN=1 instruments emitted code and runtime. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import ts5 from "typescript";
import { compile } from "@scriptc/compiler";
import { corpusSelect, shardSuffix } from "./shard.js";
import { libnodePack, requiresLibnode } from "./libnode.js";
import { tscJsxOracleEntry, wantsTscJsx } from "./jsx-oracle.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const corpusDir = join(repoRoot, "tests/corpus");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");

// Same corpus, same SCRIPTC_TEST_SHARD slice as differential.test.ts (the
// two files split identically, so a shard's compile cache serves both lanes).
const ENTRY_EXTS = ["ts", "js", "mjs", "cjs"];
const files = corpusSelect(
  ENTRY_EXTS.flatMap((ext) => [
    ...globSync(join(corpusDir, `*.${ext}`)),
    ...globSync(join(corpusDir, `*/main.${ext}`)),
  ]).sort(),
  (f) => f.slice(corpusDir.length + 1),
  process.env["SCRIPTC_SAN"] === "1",
);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const requestedMode = process.env["SCRIPTC_LLVM_TEST_MODE"];
if (requestedMode !== undefined && requestedMode !== "release" && requestedMode !== "dev") {
  throw new Error("SCRIPTC_LLVM_TEST_MODE must be release or dev when set");
}
// Combined CI lanes cover release in differential.test.ts. Standalone and
// packaged-artifact runs retain both modes unless one is explicitly selected.
const optimizationModes: readonly ("release" | "dev")[] =
  requestedMode === undefined ? ["release", "dev"] : [requestedMode];

// Same known-env contract as the main differential suite.
process.env["SCRIPTC_TEST_ENV"] = "from-harness";

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

/** First TWO lines — a program can combine directives, one per line
 * (differential.test.ts's directiveHead). */
function directiveHead(file: string): string[] {
  return readFileSync(file, "utf8").split("\n", 2);
}

function expectedExitCode(file: string): number {
  for (const line of directiveHead(file)) {
    const m = /^\/\/ @exit:\s*(\d+)\s*$/.exec(line);
    if (m) return Number(m[1]);
  }
  return 0;
}

async function runBinary(cmd: string, args: string[]): Promise<RunResult> {
  // Linux fork/exec race (observed on the sandbox lane): a sibling
  // worker's fork can inherit the freshly-linked binary's write fd across
  // its own spawn window, and exec answers ETXTBSY until that fd closes.
  // The condition is transient by construction — retry briefly, the
  // npm/cargo stance.
  for (let attempt = 0; ; attempt++) {
    const pending = execFileAsync(cmd, args, { encoding: "buffer" });
    pending.child.stdin?.end();
    try {
      const { stdout, stderr } = await pending;
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as { code?: unknown; stdout?: Buffer; stderr?: Buffer };
      if (e.code === "ETXTBSY" && attempt < 10) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      if (typeof e.code !== "number" || !Buffer.isBuffer(e.stdout) || !Buffer.isBuffer(e.stderr)) {
        throw err;
      }
      return { stdout: e.stdout, stderr: e.stderr, exitCode: e.code };
    }
  }
}

function comparableStderr(stderr: Buffer): Buffer {
  if (!sanitize) return stderr;
  const lines = stderr.toString("utf8").split("\n");
  const kept = lines.filter(
    (l) =>
      !l.startsWith("scriptc RC audit skipped:") &&
      // Linux ASan's once-per-process fiber-swapcontext warning (see
      // differential.test.ts's comparableStderr).
      !/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext/.test(l),
  );
  return Buffer.from(kept.join("\n"), "utf8");
}

const comptimeShim = pathToFileURL(join(import.meta.dirname, "comptime-shim.mjs")).href;

/** differential.test.ts's twin: the Node oracle runs with
 * --experimental-transform-types for corpus programs using non-erasable
 * syntax — the `// @transform-types` directive (namespaces) OR any enum
 * declaration (strip-only mode refuses to parse enums, no directive
 * needed; a pure function of the program bytes). */
function wantsTransformTypes(file: string): boolean {
  if (directiveHead(file).some((l) => /^\/\/ @transform-types\s*$/.test(l))) return true;
  return programInputs(file).some((f) => /\benum\s+[A-Za-z_$]/.test(readFileSync(f, "utf8")));
}

/** `// @tsc-decorators` (differential.test.ts's twin): decorators are the
 * one supported construct Node cannot execute at all, so the oracle runs
 * tsc's deterministic ES2022 downlevel materialized under the test cache. */
function wantsTscDecorators(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @tsc-decorators\s*$/.test(l));
}

function nodeOracleFile(file: string): string {
  if (wantsTscJsx(directiveHead(file))) return tscJsxOracleEntry(file, cacheDir);
  if (!wantsTscDecorators(file)) return file;
  const src = readFileSync(file, "utf8");
  const out = ts5.transpileModule(src, {
    compilerOptions: { target: ts5.ScriptTarget.ES2022, module: ts5.ModuleKind.ESNext },
    fileName: file,
  }).outputText;
  const key = createHash("sha256")
    .update(ts5.version)
    .update("\0")
    .update(src)
    .digest("hex")
    .slice(0, 16);
  const path = join(cacheDir, `dec-oracle-${key}.mjs`);
  mkdirSync(cacheDir, { recursive: true });
  // Atomic publish: concurrent suites (the other flavor's full run, or
  // another lane over the same program) write this same content-keyed
  // path; rename keeps readers from ever seeing a truncated oracle.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, out);
  renameSync(tmp, path);
  return path;
}

function wantsNoDeprecation(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @no-deprecation\s*$/.test(l));
}

function nodeOracleArgs(file: string): string[] {
  const transform = wantsTransformTypes(file)
    ? ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"]
    : [];
  const nodep = wantsNoDeprecation(file) ? ["--no-deprecation"] : [];
  // differential.test.ts's @disallow-code-generation directive.
  const codegen = directiveHead(file).some((l) => /^\/\/ @disallow-code-generation\s*$/.test(l))
    ? ["--disallow-code-generation-from-strings"]
    : [];
  // --import makes Node load even a CJS entry through its ESM loader,
  // changing an entry throw's uncaughtException origin to unhandledRejection.
  const shims = directiveHead(file).includes("// @no-node-shims") ? [] : ["--import", comptimeShim];
  return [...transform, ...nodep, ...codegen, ...shims, nodeOracleFile(file)];
}

function programInputs(file: string): string[] {
  if (!/\/main\.(ts|js|mjs|cjs)$/.test(file)) return [file];
  return [
    ...[...ENTRY_EXTS, "tsx", "jsx"].flatMap((ext) => globSync(join(file, `../**/*.${ext}`))),
    ...globSync(join(file, "../**/tsconfig.json")),
    ...globSync(join(file, "../**/package.json")),
  ].sort();
}

async function build(file: string, optimization: "release" | "dev") {
  const hash = createHash("sha256");
  for (const f of programInputs(file)) hash.update(f).update(readFileSync(f));
  const key = hash
    .update(sanitize ? "san" : "plain")
    .update("llvm-" + optimization)
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, key);
  mkdirSync(outDir, { recursive: true });
  return compile(file, {
    outPath: join(outDir, `program-llvm-${optimization}${sanitize ? "-san" : ""}`),
    outDir,
    sanitize,
    optimization,
  });
}

describe(`llvm differential corpus (${files.length} programs, ${optimizationModes.join("+")}${sanitize ? ", sanitized" : ""}${shardSuffix()})`, () => {
  test.for(files.map((f) => [f.slice(corpusDir.length + 1), f] as const))(
    "%s",
    async ([rel, file], { skip }) => {
      // Programs that call into Node need a libnode pack (libnode.ts).
      if (requiresLibnode(file) && libnodePack() === null) skip();
      const oracle = await runBinary(process.execPath, nodeOracleArgs(file));
      const expectedExit = expectedExitCode(file);
      expect(oracle.exitCode).toBe(expectedExit);
      for (const optimization of optimizationModes) {
        const result = await build(file, optimization);
        if (!result.ok)
          throw new Error(
            `${rel} (${optimization}): ` +
              result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; "),
          );
        expect(result.backend).toBe("llvm");
        expect(result.llvmPath.endsWith(".ll")).toBe(true);
        const actual = await runBinary(result.binaryPath, []);
        expect(actual.stdout, `${optimization} stdout`).toEqual(oracle.stdout);
        if (expectedExit === 0)
          expect(comparableStderr(actual.stderr), `${optimization} stderr`).toEqual(oracle.stderr);
        expect(actual.exitCode, `${optimization} exit status`).toBe(expectedExit);
      }
    },
  );
});
