/* Lane loops, differentially (planning rules are in
 * packages/compiler/src/ir/lane-plans.test.ts, emission is in
 * packages/compiler/src/backend/llvm/lanes.test.ts).
 *
 * SCRIPTC_LANES_PLAN is a build-time choice, so the corpus, which builds every
 * program the same way, cannot cover the lowering itself. This fixture is
 * built with every shape planned and run twice: once with the run-time toggle
 * on and once with it off. Both runs must print exactly what Node prints.
 *
 * The fixture's own comments name the cases that pin the two rules the
 * lowering leans on: the reduction reads the accumulator the lane loop leaves
 * at its end, and the entry guard keeps every partial sum an exact double.
 * The cases are lengths that are a multiple of the vector width (a dropped
 * group changes the sum) and lengths at and above the element count bound
 * (where an unbounded lane loop would round differently from Node). */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const sourceFile = join(repoRoot, "tests/fixtures/lane-loops/main.ts");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const saved = process.env["SCRIPTC_LANES_PLAN"];

afterEach(() => {
  if (saved === undefined) delete process.env["SCRIPTC_LANES_PLAN"];
  else process.env["SCRIPTC_LANES_PLAN"] = saved;
});

async function build(plan: string | null, tag: string): Promise<{ binary: string; llvm: string }> {
  if (plan === null) delete process.env["SCRIPTC_LANES_PLAN"];
  else process.env["SCRIPTC_LANES_PLAN"] = plan;
  const name = `lane-loops-${tag}${sanitize ? "-san" : ""}`;
  const key = createHash("sha256")
    .update(readFileSync(sourceFile))
    .update(`${plan}/${tag}/${sanitize ? "san" : "plain"}`)
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `${name}-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(sourceFile, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    backend: "llvm",
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return { binary: result.binaryPath, llvm: readFileSync(result.llvmPath, "utf8") };
}

async function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { env, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

test("a lane-built fixture prints what Node prints, with the toggle on and off", async () => {
  const expected = await run(process.execPath, [sourceFile], process.env);
  expect(expected.split("\n").length).toBeGreaterThan(1000);
  const { binary } = await build("all", "on");
  const on = await run(binary, [], { ...process.env, SCRIPTC_LANES: "1" });
  expect(on).toBe(expected);
  const off = await run(binary, [], { ...process.env, SCRIPTC_LANES: "0" });
  expect(off).toBe(expected);
}, 300_000);

test("the planned build really carries lane loops", async () => {
  // Without this, the parity above could pass with the lowering switched off.
  const { llvm } = await build("all", "shapes");
  expect(llvm).toMatch(/@sc_lanes = internal global i32 1/);
  expect(llvm).toMatch(/load <4 x i8>, ptr [^,]+, align 1/);
  expect(llvm).toMatch(/load <4 x i16>, ptr [^,]+, align 1/);
  expect(llvm).toMatch(/load <4 x i32>, ptr [^,]+, align 1/);
  expect(llvm).toMatch(/icmp ult i64 [^,]+, 2097152/);
  expect(llvm).toMatch(/icmp ult i64 [^,]+, 137438953472/);
  expect(llvm).toMatch(/icmp ult i64 [^,]+, 35184372088832/);
  // The loop inside the switch's quiet case is planned, so the writing case
  // next to it is refused by the accumulator rule and not by its shape.
  const clean = llvm.slice(llvm.indexOf("sumSwitchClean32"));
  expect(clean.slice(0, clean.indexOf("\ndefine "))).toMatch(/lane\.c\d+:/);
  // Dense number arrays: the sum and the double-accumulator count lane the
  // int32 slots, the store loops write whole vectors of doubles, and the
  // entry tests ask the storage kind and that every slot below the length
  // holds a value.
  const dense = (name: string): string => {
    const at = llvm.indexOf(`@sc_bf_${name}(`);
    return llvm.slice(at, llvm.indexOf("\ndefine ", at));
  };
  const sum = dense("denseSum");
  expect(sum).toMatch(/icmp eq i8 [^,]+, 7/);
  expect(sum).toMatch(/icmp ule i64 [^,]+, %t\d+/);
  expect(sum).toMatch(/load <4 x i32>, ptr [^,]+, align 1/);
  expect(dense("denseCountRoot")).toMatch(/lane\.c\d+:/);
  const store = dense("denseZero");
  expect(store).toMatch(/icmp eq i8 [^,]+, 0/);
  expect(store).toMatch(/store <4 x double> [^,]+, ptr [^,]+, align 1/);
  // The count whose accumulator stays in an int32 slot, and the division,
  // keep their scalar loops.
  expect(dense("denseCountBelow")).not.toMatch(/lane\./);
  expect(dense("denseHalve")).not.toMatch(/lane\./);
}, 300_000);

test("a build without the plan flag emits the scalar loops and no toggle", async () => {
  const planned = await build("all", "carried");
  const plain = await build(null, "plain");
  expect(planned.llvm.length).toBeGreaterThan(plain.llvm.length);
  expect(plain.llvm).not.toMatch(/@sc_lanes/);
  expect(plain.llvm).not.toMatch(/lane\./);
  expect(plain.llvm).not.toMatch(/load <4 x i(8|16|32|64)>/);
  expect(plain.llvm).not.toMatch(/load <4 x double>/);
  expect(plain.llvm).not.toMatch(/store <4 x double>/);
}, 300_000);
