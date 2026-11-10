import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

/** The LLVM text and the IR function names of a one-file program. */
async function emitted(
  file: string,
  source: string,
): Promise<{ llvm: string; functions: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-class-key-table-"));
  try {
    const entry = join(dir, file);
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    return { llvm: emitLlvmModule(mod), functions: mod.functions.map((fn) => fn.name) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The definitions of the generated helpers whose name starts with `prefix`. */
function helpers(llvm: string, prefix: string): string[] {
  return [...llvm.matchAll(new RegExp(`^define internal [^\\n]*@${prefix}[^]*?^}`, "gm"))].map(
    (match) => match[0],
  );
}

test("a program that boxes a class and dispatches on none pays for no lookup function", async () => {
  const { llvm } = await emitted(
    "main.ts",
    `
class Box {
  constructor(public v: number) {}
}
const held: any = new Box(1);
const later: any = Promise.resolve("a");
async function main(): Promise<void> {
  const text = await (later as Promise<string>);
  console.log((held as Box).v, text);
}
main();
`,
  );
  // The program boxes a Box, so it has a class key table, and the checked
  // conversion to Box reads the capsule's key against the table's slot.
  expect(llvm).toMatch(/^@sc_class_keys_\w+ = internal constant /m);
  const checks = helpers(llvm, "sc_dc_");
  const ofBox = checks.filter((check) => check.includes("@sc_class_keys_"));
  expect(ofBox.length).toBeGreaterThan(0);
  // No class table switches on a slot, so nothing calls the table's lookup
  // function and it is not written.
  expect(llvm).not.toMatch(/@sc_class_keys_\w+_find\(/);
  // A checked conversion that names no class of the table reads no table:
  // its key is a constant of its own, compared by address and then by name.
  const ofPromise = checks.filter((check) => /\{ ; check promise<string>\n/.test(check));
  expect(ofPromise.length).toBeGreaterThan(0);
  for (const check of ofPromise) {
    expect(check).not.toContain("@sc_class_keys_");
    expect(check).toMatch(/icmp eq ptr %t\d+, @sc_cs_\w+\n/);
    expect(check).toContain("call zeroext i1 @scr_dyn_typed_ref_is(");
  }
});

test("a class table that switches on the receiver's slot still calls the copies that return nothing", async () => {
  const { llvm, functions } = await emitted(
    "main.js",
    `
class Point {
  constructor(x) { this.x = x; }
  step(d) { this.x += d; return this; }
}
class Tagged extends Point {
  constructor(x, tag) { super(x); this.tag = tag; }
}
class Plain {
  constructor(x) { this.x = x; }
  step(d) { this.x -= d; return this; }
}
function move(p) { return p.step(1).step(2); }
var list = [0, 1, 2].map((i) => (i === 0 ? new Point(1) : i === 1 ? new Tagged(2, "t") : new Plain(3)));
for (const p of list) console.log(move(p).x);
`,
  );
  // Three classes: the dispatch helper selects the receiver's class by its
  // slot in the class key table, and the table's lookup function is written.
  const dispatch = helpers(llvm, "sc_b?f__x25_dyn_class_call_\\d+\\(");
  expect(dispatch.some((helper) => /call i32 @sc_class_keys_\w+_find\(/.test(helper))).toBe(true);
  expect(llvm).toMatch(/^define internal i32 @sc_class_keys_\w+_find\(/m);
  // step returns its receiver: each case calls the method's copy that
  // returns nothing and answers the capsule the helper already holds.
  expect(functions).toContain("%dyn.class.receiver:Point.step");
  expect(functions).toContain("%dyn.class.receiver:Plain.step");
  expect(
    dispatch.some((helper) => helper.includes("@sc_bf__x25_dyn_class_receiver_x3a_Point_step(")),
  ).toBe(true);
});
