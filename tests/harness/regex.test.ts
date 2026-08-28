/* Regex behavior that is scriptc-only by nature — deliberately NOT in the
 * differential corpus (tests/corpus/1200.. holds everything Node-comparable):
 *
 * - The statefulness fence at runtime: test() on a g/y regex that flowed
 *   through a variable (the frontend only sees literal receivers) must
 *   abort with the fence message, never silently model lastIndex.
 * - split() on a pattern with capture groups: Node splices the captured
 *   values into the result — scriptc throws a catchable TypeError naming
 *   the limitation instead, so the caught branch is asserted here.
 * - The two size/stability pins: a regex-free program must not reference
 *   the regex runtime at all (byte-identical link line — its C names no
 *   ScrRegex symbol), and a regex-USING static binary pays libregexp
 *   (~110KB), never the ~620KB engine class: well under 300KB.
 *
 * SCRIPTC_SAN=1 builds the programs with ASan + the RC audit.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const platformTest = process.env["SCRIPTC_PORTABLE_ONLY"] === "1" ? test.skip : test;

interface BuildResult {
  binaryPath: string;
  cPath: string;
}

/** Compiles an inline program (static by default — regex needs no flag). */
async function build(
  name: string,
  source: string,
  opts: { sanitize?: boolean } = {},
): Promise<BuildResult> {
  const san = opts.sanitize ?? sanitize;
  const key = createHash("sha256")
    .update(source)
    .update(san ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `regex-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.ts`);
  writeFileSync(file, source);
  // Pinned: the size/stability pins below grep the emitted C (no ScrRegex
  // symbol) and weigh the C-lane binary — this suite measures the C
  // backend's artifact by design.
  const result = await compile(file, { outPath: join(outDir, name), outDir, sanitize: san, backend: "c" });
  if (!result.ok) {
    throw new Error(
      "regex program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return { binaryPath: result.binaryPath, cPath: result.cPath };
}

describe("regex (scriptc-only behavior)", () => {
  test("test() on a g-flagged regex reaching runtime aborts with the fence message", async () => {
    // The g flag is invisible to the frontend here: the regex flows through
    // a function parameter, so the RUNTIME fence must catch it.
    const r = await build(
      "g-test-runtime",
      `function check(re: RegExp, s: string): boolean {
  return re.test(s);
}
console.log("before");
console.log(check(/a/g, "abc"));
`,
    );
    const err = await execFileAsync(r.binaryPath, []).then(
      () => {
        throw new Error("expected the g-flagged test() to abort");
      },
      (e: Error & { signal?: string; stdout?: string; stderr?: string }) => e,
    );
    expect(err.signal).toBe("SIGABRT");
    expect(err.stdout).toContain("before");
    expect(err.stderr).toContain(
      "test() on a regex with the 'g' or 'y' flag is not supported",
    );
  });

  test("split() with capture groups throws a catchable TypeError (Node would splice them in)", async () => {
    const r = await build(
      "split-captures",
      `try {
  const parts = "a,b".split(/(,)/);
  console.log("unreachable", parts.length);
} catch {
  console.log("caught");
}
`,
    );
    const { stdout } = await execFileAsync(r.binaryPath, []);
    expect(stdout).toBe("caught\n");
  });

  test("a pattern the engine rejects aborts at first use with a SyntaxError message", async () => {
    // tsc's parser (and V8) accept 300 capture groups; libregexp caps
    // captures at 255, so the engine rejects the pattern at its LAZY
    // compile on first use — Node would run it fine (the abort is the
    // documented divergence surface: engine-level rejections happen at
    // first use, not at program parse time).
    const r = await build(
      "lazy-compile-error",
      `console.log("before");
console.log(/${"(a)".repeat(300)}/.test("a"));
`,
    );
    const err = await execFileAsync(r.binaryPath, []).then(
      () => {
        throw new Error("expected the invalid pattern to abort");
      },
      (e: Error & { signal?: string; stdout?: string; stderr?: string }) => e,
    );
    expect(err.signal).toBe("SIGABRT");
    expect(err.stdout).toContain("before");
    expect(err.stderr).toContain("SyntaxError: Invalid regular expression:");
  });

  platformTest("regex-free programs never reference the regex runtime; regex use stays in its size class", async () => {
    // Measured on plain (non-ASan) builds. A regex-free program's C names
    // no ScrRegex symbol, so its link line is the historical one (the
    // compact static size class is pinned by island.test.ts). A regex-USING
    // binary links libregexp + libunicode, but must stay far below the
    // embedded-engine size class.
    const [plainBuild, regexBuild] = await Promise.all([
      build("size-plain", `console.log("hello", "world");\n`, { sanitize: false }),
      build(
        "size-regex",
        `console.log("a-b c".replace(/[-\\s]/g, "_"), /\\p{L}+/u.test("héllo"));\n`,
        { sanitize: false },
      ),
    ]);
    const plainC = readFileSync(plainBuild.cPath, "utf8");
    expect(plainC).not.toContain("ScrRegex");
    expect(plainC).not.toContain("scr_regex");
    // The class bounds are page-granular (macOS rounds segments to 16KB,
    // so a few hundred bytes of new runtime can tip a whole page): the net
    // loop hooks, the console/process/child surface (the piped-stream
    // slice included — scr_child.c is always linked), the
    // fs-scandir/Math-static slice, the path.win32 port, and the Buffer
    // numeric/encoding/search families (~11KB of always-linked bytes
    // runtime) each cost pages — regex linkage would be a ~110KB jump
    // above the static class, the engine a ~620KB one. The regex class
    // carries scr_assert.c (the regex link switch has always pulled it),
    // so the assert.throws shape machinery — the Comparison diff renderer
    // and the throws/rejects helpers — re-based it by a page, and the
    // dyn-assert machinery (the compact:false dyn renderer plus the real
    // myers line-diff printer) re-based it by another; the primitive-
    // prototype formatters (toExponential/toFixed0, Date.UTC, String.raw)
    // re-based the static class by one more; the ambient-receiver stack,
    // the %j dyn stringify walk, and the runtime-encoding readFileSync
    // form (all in always-linked TUs) tipped the regex class one more
    // page; positioned readSync's cross-platform pread seam tipped the
    // Mach-O regex class by one further page. Native Response construction
    // and mutable constructed Headers added another page to both Darwin
    // classes; the Linux bounds were rebased by the same 16KB while
    // preserving their existing cushion.
    // The canonical Ubuntu 24.04/clang Sandbox measures 387,600 bytes for
    // the plain binary and 540,232 with regex linked. The Linux bounds leave
    // roughly one ELF page of growth. Current Mach-O toolchains measure
    // 398,024 bytes for the plain binary, whose bound likewise leaves about
    // one native page; neither cushion can hide an engine-sized jump.
    expect(statSync(plainBuild.binaryPath).size).toBeLessThan(
      process.platform === "linux" ? 408_000 : 415_000,
    );
    expect(statSync(regexBuild.binaryPath).size).toBeLessThan(
      process.platform === "linux" ? 561_000 : 545_000,
    );
  });
});
