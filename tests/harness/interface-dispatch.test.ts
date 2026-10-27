/* Interface method dispatch cost model (behavior is in the differential
 * corpus, 5165-5169): a call through an interface implemented by program
 * classes keeps its static argument and result types and reaches the
 * implementing methods directly, while a method that an instance can
 * replace keeps the checked dynamic call. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");

async function emittedLlvm(name: string, source: string): Promise<string> {
  const key = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const outDir = join(cacheDir, `iface-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.ts`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    backend: "llvm",
    outputKind: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "interface program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return readFileSync(result.artifact.path, "utf8");
}

/** The bodies of a function and its numeric specializations. */
function bodies(llvm: string, name: string): string {
  return llvm
    .split("\ndefine ")
    .filter((definition) => new RegExp(`^internal \\S+ @${name}[.(]`).test(definition))
    .map((definition) => definition.slice(0, definition.indexOf("\n}\n")))
    .join("\n");
}

const shapes = (extra: string): string => `interface Shape {
  scale(k: number): number;
}
class Circle implements Shape {
  constructor(public r: number) {}
  scale(k: number): number {
    return this.r * k;
  }
}
class Rect implements Shape {
  constructor(public w: number) {}
  scale(k: number): number {
    return this.w * k;
  }
}
function run(s: Shape, n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) t += s.scale(i);
  return t;
}
const circle = new Circle(2);
${extra}
console.log(run(circle, 10), run(new Rect(3), 10));
`;

describe("interface method dispatch", () => {
  test("calls through an interface reach the implementing methods with typed values", async () => {
    const llvm = await emittedLlvm("direct", shapes(""));
    const run = bodies(llvm, "sc_bf_run");
    expect(run).toMatch(/(?:call|invoke) double @sc_bf__x25_dyn_class_protocol_\d+/);
    expect(run).not.toContain("@scr_dyn_call");
    expect(run).not.toContain("@sc_bf__x25_dyn_class_property_");
    const dispatch = llvm.slice(llvm.indexOf("; %dyn.class.protocol.0"));
    expect(dispatch).toMatch(/call double @sc_bf__x25_Circle_scale\(ptr [^,]+, double/);
    expect(dispatch).toMatch(/call double @sc_bf__x25_Rect_scale\(ptr [^,]+, double/);
  });

  test("arrays of interface values iterate natively and pass typed receivers", async () => {
    const llvm = await emittedLlvm(
      "array",
      shapes(`function sum(list: Shape[]): number {
  let t = 0;
  for (const s of list) t += s.scale(2);
  return t;
}
console.log(sum([circle, new Rect(1)]));`),
    );
    const sum = bodies(llvm, "sc_bf_sum");
    expect(sum).toMatch(/(?:call|invoke) double @sc_bf__x25_dyn_class_protocol_\d+/);
    expect(sum).not.toContain("@scr_dyn_iterator");
    expect(sum).not.toContain("@sc_bf__x25_dyn_class_computed_");
  });

  test("property reads through an interface read the implementing field", async () => {
    const llvm = await emittedLlvm(
      "field",
      `interface Sized {
  size: number;
}
class Box implements Sized {
  size = 3;
}
function size(s: Sized): number {
  return s.size + 1;
}
console.log(size(new Box()));
`,
    );
    expect(bodies(llvm, "sc_bf_size")).not.toContain("@sc_bf__x25_dyn_class_property_");
    const helper = llvm.indexOf("; %dyn.class.protocol.0");
    expect(llvm.slice(helper, llvm.indexOf("\n}\n", helper))).toMatch(
      /getelementptr inbounds %sc_o_Box, ptr [^,]+, i64 0, i32 \d+/,
    );
  });

  test("matched receivers unbox without reference counting, ahead of an out-of-line fallback", async () => {
    const llvm = await emittedLlvm("inline", shapes(""));
    const helper = llvm.indexOf("; %dyn.class.protocol.0");
    const dispatch = llvm.slice(llvm.lastIndexOf("define", helper), llvm.indexOf("\n}\n", helper));
    expect(dispatch).toContain("; ->v.typed_ref.ptr");
    expect(dispatch).not.toMatch(/call ptr @sc_retain_(?:Circle|Rect)\(/);
    expect(dispatch).toMatch(/\binlinehint\b/);
    expect(llvm).toMatch(
      /define internal [^\n]*@sc_bf__x25_dyn_class_protocol_fallback_0[^\n]*\bnoinline\b/,
    );
  });

  test("loops lend interface array elements to dispatch that cannot release them", async () => {
    const lent = await emittedLlvm(
      "lent",
      shapes(`function sum(list: Shape[]): number {
  let t = 0;
  for (const s of list) t += s.scale(2);
  return t;
}
console.log(sum([circle, new Rect(1)]));`),
    );
    expect(bodies(lent, "sc_bf_sum")).not.toContain("@scr_dyn_retain_v");
    // A method that can empty the array keeps the owned element read.
    const owned = await emittedLlvm(
      "owned",
      shapes(`const kept: Shape[] = [];
class Emptying implements Shape {
  scale(k: number): number {
    kept.length = 0;
    return k;
  }
}
kept.push(new Emptying(), circle);
function sum(list: Shape[]): number {
  let t = 0;
  for (const s of list) t += s.scale(2);
  return t;
}
console.log(sum(kept));`),
    );
    expect(bodies(owned, "sc_bf_sum")).toContain("@scr_dyn_retain_v");
  });

  test("a method an instance can replace keeps the checked dynamic call", async () => {
    const llvm = await emittedLlvm(
      "replaced",
      shapes(`(circle as unknown as { scale: (k: number) => number }).scale = (k) => -k;`),
    );
    const helper = llvm.indexOf("; %dyn.class.protocol.0");
    const dispatch = llvm.slice(helper, llvm.indexOf("\n}\n", helper));
    expect(dispatch).not.toContain("@sc_bf__x25_Circle_scale(");
    expect(dispatch).not.toContain("@sc_bf__x25_Rect_scale(");
  });
});
