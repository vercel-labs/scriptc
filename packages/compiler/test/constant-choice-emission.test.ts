import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("a chain of literal stores is one store of a table entry, indexed as on every path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-constant-choices-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(
      entry,
      `
function bases(arr: Uint8Array): void {
  for (let i = 0; i < arr.length; ++i) {
    const x = arr[i];
    if (x === 97) arr[i] = 0;
    else if (x === 116) arr[i] = 1;
    else if (x === 99) arr[i] = 2;
    else arr[i] = 3;
  }
}
function wide(flag: boolean): string {
  const a = new Uint8Array(4);
  let j = 0;
  if (flag) j = 4294967297;
  if (j === 0) a[j] = 11;
  else if (j === 1) a[j] = 22;
  else if (j === 2) a[j] = 33;
  else a[j] = 44;
  return a.join(",");
}
const sequence = new Uint8Array([97, 116, 99, 103]);
bases(sequence);
console.log(sequence.join(","), wide(true), wide(false));
`,
    );
    const outPath = join(dir, "main.ir.json");
    const lowered = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!lowered.ok)
      throw new Error(lowered.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const ll = emitLlvmModule(deserializeModule(await readFile(outPath, "utf8")));
    const body = (name: string): string =>
      ll.match(
        new RegExp(`define internal [^\\n]+ @sc_[bf]+_${name}\\([^\\n]*\\) #0 \\{[\\s\\S]*?\\n\\}`),
      )![0];

    // The cases' span, 97 to 116, with the final else's 3 between the cases.
    expect(ll).toMatch(
      /@sc_choice_\w+ = private unnamed_addr constant \[20 x i32\] \[i32 0, i32 3, i32 2, (i32 3, ){16}i32 1\]/,
    );
    expect(body("bases")).toMatch(/load i32, ptr %\S+\n/);

    // The index is the compared local. Inside the first arm its range is
    // [0, 0], but the one store also runs for 4294967297, so the index
    // converts as the local's whole range allows (to i64), not to i32.
    const wide = body("wide");
    expect(wide).toMatch(/@sc_choice_\w+, i64 0, i64/);
    expect(wide).not.toMatch(/fptosi double %\S+ to i32/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
