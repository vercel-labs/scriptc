/* The event-loop gate (stage 2 of the library emission mode): v1 library
 * mode refuses any timer/event-loop/ambient-process surface anywhere in
 * the module graph — SC4005's detector, module-graph-derived, never
 * runtime-observed. Programs here compile fine as EXECUTABLES (the exe
 * lane keeps its loop); what is asserted is the IR-level detection the
 * library path refuses on.
 *
 * Promises, `await`, and `async` functions are ADMITTED: a continuation
 * is queued work rather than a turn, and the host runs the queue itself
 * through the profile's drain entry. The gate's job is to keep the line
 * exactly there — everything a loop turn would have to SERVICE stays
 * refused, and the two async shapes with no host-drain story (a top-level
 * await, and generators) stay refused with it. `moduleUsesAsync` is the
 * complementary fact: not "is this refused" but "does this graph need the
 * promise/fiber unit linked". */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile, ir } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
/* Suite-flavor segment: the plain and SCRIPTC_SAN=1 suites may run
 * concurrently (the suite lock is per flavor) and both run these same
 * builds, so they must never share build dirs. */
const flavor = process.env["SCRIPTC_SAN"] === "1" ? "san" : "plain";

async function moduleOf(name: string, source: string): Promise<ir.IrModule> {
  const outDir = join(cacheDir, `lib-asyncfree-${flavor}`, name);
  mkdirSync(outDir, { recursive: true });
  const entry = join(outDir, "main.ts");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    emitIr: true,
    backend: "c",
  });
  if (!result.ok) {
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  }
  return JSON.parse(readFileSync(result.irPath!, "utf8")) as ir.IrModule;
}

async function surfaceOf(name: string, source: string): Promise<string | null> {
  const hit = ir.moduleLibAsyncSurface(await moduleOf(name, source));
  if (hit !== null) {
    // The anchor must be usable (a real file offset or the entry fallback).
    expect(hit.loc.file.length).toBeGreaterThan(0);
  }
  return hit === null ? null : hit.surface;
}

describe("the library event-loop gate over the IR", () => {
  test("a sync graph is async_free", async () => {
    expect(
      await surfaceOf(
        "clean",
        `export function update(n: number): number { return n * 2; }\nconsole.log(update(21));\n`,
      ),
    ).toBeNull();
  });

  test("an async function is admitted — its continuation is the host's to drain", async () => {
    expect(
      await surfaceOf(
        "async-fn",
        `async function tick(): Promise<number> { return 1; }\nvoid tick();\nconsole.log("x");\n`,
      ),
    ).toBeNull();
  });

  test("await and promise values are admitted", async () => {
    expect(
      await surfaceOf(
        "await-promise",
        `async function twice(p: Promise<number>): Promise<number> { return (await p) * 2; }\n` +
          `void twice(Promise.resolve(21));\nconsole.log("x");\n`,
      ),
    ).toBeNull();
  });

  test("queueMicrotask is admitted — it is the job queue, not a timer", async () => {
    expect(
      await surfaceOf("micro", `queueMicrotask(() => console.log("m"));\n`),
    ).toBeNull();
  });

  test("a top-level await refuses: library init has nothing to wait on", async () => {
    expect(
      await surfaceOf(
        "top-level-await",
        `const v = await Promise.resolve(1);\nconsole.log(v);\n`,
      ),
    ).toContain("top-level await");
  });

  test("fs.promises stays refused even though its promises settle eagerly", async () => {
    expect(
      await surfaceOf(
        "fsp",
        `import { readFile } from "node:fs/promises";\n` +
          `async function read(): Promise<string> { return await readFile("x", "utf8"); }\n` +
          `void read();\nconsole.log("x");\n`,
      ),
    ).toContain("fs.promises");
  });

  test("a generator refuses", async () => {
    expect(
      await surfaceOf(
        "gen",
        `function* seq(): Generator<number> { yield 1; }\nfor (const v of seq()) console.log(v);\n`,
      ),
    ).toContain("generator");
  });

  test("setTimeout refuses as the timers surface", async () => {
    expect(await surfaceOf("timer", `setTimeout(() => console.log("t"), 1);\n`)).toContain("timers");
  });

  test("child_process refuses even in its synchronous spelling", async () => {
    expect(
      await surfaceOf(
        "child",
        `import { spawnSync } from "node:child_process";\nconst r = spawnSync("true", []);\nconsole.log(r.status === null ? -1 : r.status);\n`,
      ),
    ).toContain("child_process");
  });

  test("process signal listeners refuse", async () => {
    expect(
      await surfaceOf("sig", `process.on("SIGINT", () => console.log("int"));\nconsole.log("armed");\n`),
    ).toContain("signal");
  });

  test("process output completion callbacks refuse as event-loop work", async () => {
    expect(
      await surfaceOf(
        "stdout-write-callback",
        `process.stdout.write("x", () => console.log("written"));\n`,
      ),
    ).toContain("process.stdout.write completion callbacks");
  });

  test("explicitly omitted process output callbacks stay admitted", async () => {
    expect(
      await surfaceOf(
        "stdout-write-undefined",
        `process.stdout.write("x", undefined);\nprocess.stdout.write("y", "utf8", undefined);\n`,
      ),
    ).toBeNull();
  });
});

describe("the promise/fiber link gate over the IR", () => {
  test("a graph with no continuation needs no promise unit", async () => {
    expect(
      ir.moduleUsesAsync(
        await moduleOf("gate-clean", `export function twice(n: number): number { return n * 2; }\nconsole.log(twice(21));\n`),
      ),
    ).toBe(false);
  });

  test("an async function, an await, a promise value, and queueMicrotask each need it", async () => {
    for (const [name, source] of [
      ["gate-async", `async function t(): Promise<number> { return 1; }\nvoid t();\nconsole.log("x");\n`],
      ["gate-promise", `const p = Promise.resolve(1);\nvoid p.then((v) => console.log(v));\n`],
      ["gate-micro", `queueMicrotask(() => console.log("m"));\n`],
      ["gate-tick", `process.nextTick(() => console.log("t"));\n`],
    ] as const) {
      expect(ir.moduleUsesAsync(await moduleOf(name, source)), name).toBe(true);
    }
  });
});
