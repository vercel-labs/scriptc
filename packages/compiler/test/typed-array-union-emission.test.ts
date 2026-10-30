import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-typed-array-unions-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function body(llvm: string, name: string): string {
  return new RegExp(`^define [^@]*@sc_b?f_${name}(\\.i32)?\\([^]*?^}`, "m").exec(llvm)?.[0] ?? "";
}

const source = `
type UintArray = Uint8Array | Uint16Array | Uint32Array;
const pick = (max: number, n: number): UintArray =>
  max <= 256 ? new Uint8Array(n) : max <= 65536 ? new Uint16Array(n) : new Uint32Array(n);
function total(xs: UintArray): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return s;
}
function first(max: number): number {
  return pick(max, 4)[0]!;
}
const xs = pick(Number(process.argv.length) * 100000, 8);
for (let i = 0; i < xs.length; i++) xs[i] = i;
console.log(total(xs), first(10));
`;

test("element reads of a union of typed arrays load each arm's own element kind in place", async () => {
  const llvm = await emitLlvm(source);
  const total = body(llvm, "total");
  // One load per arm, each of its element width, behind the union's tag.
  for (const width of ["i8", "i16", "i32"]) expect(total).toMatch(new RegExp(`load ${width}, ptr`));
  expect(total).not.toContain("@sc_bf__x25_union_getNumber");
  // The loop over the union's length keeps an integer counter.
  expect(total).toMatch(/alloca i64/);
});

test("a typed-array union read through a computed receiver goes through one helper", async () => {
  const llvm = await emitLlvm(source);
  // The receiver is a call: evaluated once, then dispatched by the helper.
  expect(body(llvm, "first")).toContain("@sc_bf__x25_union_getNumber");
});

const stores = `
type Wide = Uint8Array | Uint16Array;
const pick = (wide: boolean): Wide => (wide ? new Uint16Array(4) : new Uint8Array(4));
function fill(xs: Wide): void {
  for (let i = 0; i < xs.length; i++) xs[i] = i + 1;
}
function rebind(): void {
  let u = pick(false);
  let i = 0;
  const swap = (): number => {
    u = pick(true);
    i = 2;
    return 3;
  };
  u[i] = swap();
  console.log(u, i);
}
fill(pick(process.argv.length > 9));
rebind();
`;

test("a typed-array union store runs in place unless its value can rebind the receiver or index", async () => {
  const llvm = await emitLlvm(stores);
  expect(body(llvm, "fill")).not.toContain("@sc_bf__x25_union_idxSet");
  // The call may assign the captured receiver and index, which the store
  // read before it: the helper evaluates them first.
  expect(body(llvm, "rebind")).toContain("@sc_bf__x25_union_idxSet");
});

test("typed-array methods on a union with a Buffer arm need a narrowing first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-typed-array-unions-"));
  try {
    const entry = join(dir, "main.ts");
    // The Buffer arm is found by its type, also through an alias name.
    for (const [declaration, method] of [
      ["const u: Buffer | Uint16Array", "slice(1)"],
      ["type Bytes = Uint16Array | Buffer;\nconst u: Bytes", "slice(1)"],
      ["type Bytes = Uint16Array | Buffer;\nconst u: Bytes", "fill(1)"],
      ["type Bytes = Uint16Array | Buffer;\nconst u: Bytes", "indexOf(1)"],
    ]) {
      await writeFile(
        entry,
        `import { Buffer } from "node:buffer";
${declaration} = process.argv.length > 9 ? new Uint16Array(2) : Buffer.alloc(2);
console.log(u.${method});
`,
      );
      const result = await compile(entry, {
        outDir: dir,
        outPath: join(dir, "main.ll"),
        outputKind: "llvm",
      });
      expect(result.ok, `${declaration} ${method}`).toBe(false);
      expect(JSON.stringify(result.diagnostics)).toContain(method.slice(0, method.indexOf("(")));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
