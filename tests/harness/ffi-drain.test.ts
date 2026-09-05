/* The executable lane's host-callable job checkpoint (`scriptc_drain`).
 *
 * Like the rest of the outbound-FFI surface this is an integration lane
 * rather than a corpus case: Node has no host that owns the main thread
 * and re-enters the program through a static-linked callback, so there is
 * nothing to differential-run against. The same TypeScript and native
 * archive run through BOTH backends and the transcript must match.
 *
 * The seam under test is the one an embedder actually hits: while the
 * program is parked inside an outbound call, scriptc's loop is not
 * running, so a continuation queued during one re-entry stays queued.
 * The host's drain is the only thing that can let it run — and it must
 * run it and RETURN, without a clock, a poll, or a turn. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureRoot = join(repoRoot, "tests/ffi-drain");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const flavor = sanitize ? "san" : "plain";
const cacheRoot = join(repoRoot, "node_modules/.cache/scriptc-tests/ffi-drain", flavor);

function nativeArchive(): string {
  const outDir = join(cacheRoot, "native");
  mkdirSync(outDir, { recursive: true });
  const object = join(outDir, "native.o");
  const archive = join(outDir, "libhostdrain.a");
  execFileSync("clang", [
    "-std=c11",
    ...(sanitize ? ["-O1", "-fsanitize=address"] : ["-O2"]),
    "-c",
    join(fixtureRoot, "native.c"),
    "-o",
    object,
  ]);
  execFileSync("ar", ["rcs", archive, object]);
  return archive;
}

/** The fixture manifest with the freshly built archive patched in — the
 * ffi.test.ts recipe, so the checked-in profile stays path-free. */
function manifest(archive: string): string {
  const outDir = join(cacheRoot, "manifest");
  mkdirSync(outDir, { recursive: true });
  const profile = JSON.parse(readFileSync(join(fixtureRoot, "profile.json"), "utf8")) as {
    libraries: string[];
  };
  profile.libraries = [archive];
  const path = join(outDir, "profile.json");
  writeFileSync(path, JSON.stringify(profile, null, 2));
  return path;
}

/* Turn by turn:
 *   1  schedules a bare continuation and starts an async handler that
 *      parks on a host-settled promise — nothing has run
 *   2  a second re-entry with NO drain between: still nothing has run,
 *      which is the reported bug's exact shape
 *   3  after the drain: the bare continuation ran; the awaiting handler
 *      is still parked, because the host has not settled its promise
 *   4  the host settled it from its own callback — settling QUEUES the
 *      continuation, it does not resume the fiber inline
 *   5  after the second drain: the await completed */
const expected = [
  "turn 1: flag=not-run not-resolved",
  "turn 2: flag=not-run not-resolved",
  "turn 3: flag=MICROTASK RAN not-resolved",
  "turn 4: flag=MICROTASK RAN not-resolved",
  "turn 5: flag=MICROTASK RAN awaited 7",
  "run returned 5",
  "after run: flag=MICROTASK RAN awaited 7",
  "",
].join("\n");

describe.each(["c", "llvm"] as const)("host job checkpoint, %s backend", (backend) => {
  test("a host that owns the thread can run pending continuations between re-entries", async () => {
    const outDir = join(cacheRoot, backend);
    mkdirSync(outDir, { recursive: true });
    const result = await compile(join(fixtureRoot, "main.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      sanitize,
      ffiProfilePath: manifest(nativeArchive()),
    });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    expect(execFileSync(result.binaryPath, [], { encoding: "utf8" })).toBe(expected);
  });

  test("draining with an async frame suspended beneath the native call restores it", async () => {
    // The outbound call is made from inside an async function, so a FIBER
    // is on the stack under the host when it drains — and what the drain
    // resumes is another fiber, which re-points the current fiber, the
    // exception cell, and the ALS context at the job and then at MAIN.
    // The suspended frame has to come back owning its own three, or its
    // next `await` parks nothing and the program dies on the runtime's
    // "await outside an async function" invariant.
    const outDir = join(cacheRoot, `async-caller-${backend}`);
    mkdirSync(outDir, { recursive: true });
    const entry = join(outDir, "main.ts");
    writeFileSync(
      entry,
      [
        "declare function nativeHostRegister(handler: (turn: number) => void): void;",
        "declare function nativeHostRun(): number;",
        "declare function nativeHostResolve(resolve: (value: number) => void): void;",
        "let flag = \"not-run\";",
        "let resolveIt: ((value: number) => void) | null = null;",
        "async function parked(): Promise<void> {",
        "  const v = await new Promise<number>((resolve) => { resolveIt = resolve; });",
        "  flag = `ran${v}`;",
        "}",
        "nativeHostRegister((turn: number): void => {",
        "  if (turn === 1) {",
        "    void parked();",
        "    const r = resolveIt;",
        "    if (r !== null) { r(9); }",
        "  }",
        "});",
        "async function driver(): Promise<string> {",
        "  const turns = nativeHostRun();",
        "  const tail = await Promise.resolve(\"tail\");",
        "  return `${turns} ${flag} ${tail}`;",
        "}",
        "// The manifest declares all three bindings; this program keeps the",
        "// third one reachable without ever calling it.",
        "const unusedResolve = (value: number): void => { flag = `${value}`; };",
        "if (flag === \"impossible\") { nativeHostResolve(unusedResolve); }",
        "void driver().then((s) => console.log(s));",
        "",
      ].join("\n"),
    );
    const result = await compile(entry, {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      sanitize,
      ffiProfilePath: manifest(nativeArchive()),
    });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    expect(execFileSync(result.binaryPath, [], { encoding: "utf8" })).toBe("5 ran9 tail\n");
  });
});
