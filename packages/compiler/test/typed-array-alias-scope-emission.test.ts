import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("a typed-array loop version proves its views disjoint and scopes their accesses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-alias-scopes-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
function copy(dst: Float64Array, src: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) dst[i] = src[i]! + 1;
}
function scale(xs: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) xs[i] = xs[i]! * 2;
}
function dot(a: Float64Array, b: Float64Array, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}
const a = new Float64Array(8), b = new Float64Array(8);
copy(a, b, 8);
scale(a, 8);
console.log(dot(a, b, 8));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const ll = emitLlvmModule(mod);
    const fn = (name: string): string =>
      new RegExp(`^define internal [^\\n]*@sc_bf_${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(ll)![0];
    // Two views, one written: the guard compares their byte ranges, and
    // each view's accesses in the fast copy carry its own scope.
    const copy = fn("copy");
    expect(copy).toMatch(/ptrtoint ptr %\w+ to i64/);
    expect(copy).toMatch(/icmp ule i64 %\w+, %\w+/);
    expect(copy).toMatch(
      /load double, ptr %\w+, align 1[^\n]*!alias\.scope !\{!\{!"copy\.0\.\d", !\{!"scriptc typed-array views"\}\}\}, !noalias/,
    );
    expect(copy).toMatch(/store double %\w+, ptr %\w+, align 1[^\n]*!alias\.scope/);
    // The fast copy declares both scopes where it starts, so they hold for
    // this entry only, and declares nothing else.
    for (const receiver of [0, 1])
      expect(copy).toContain(
        `call void @llvm.experimental.noalias.scope.decl(metadata !{!{!"copy.0.${receiver}", !{!"scriptc typed-array views"}}})`,
      );
    expect(copy.match(/noalias\.scope\.decl/g)).toHaveLength(2);
    // One view, or views that are only read, need no scopes.
    for (const name of ["scale", "dot"]) {
      expect(fn(name)).not.toContain("!alias.scope");
      expect(fn(name)).not.toContain("ptrtoint");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
