import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

/** The LLVM text of a two-module program: `table.ts` as given, and an entry
 * that reads the table only when asked to. */
async function emit(table: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-lazy-initializer-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(join(dir, "table.ts"), table);
    await writeFile(
      entry,
      `import { total } from "./table.ts";
if (process.argv.length > 2) console.log(total());
else console.log("idle");
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const computes = `
export const SQUARES: number[] = [];
for (let i = 0; i < 100; i++) SQUARES.push(i * i);
export function total(): number {
  let sum = 0;
  for (const square of SQUARES) sum += square;
  return sum;
}
`;

/** The definition of the function whose mangled name ends with `suffix`. */
function definition(llvm: string, suffix: string): string {
  const pattern = new RegExp(`^define [^\\n]*@sc_\\w*${suffix}\\([^]*?^}`, "m");
  return pattern.exec(llvm)?.[0] ?? "";
}

test.runIf(process.arch === "x64" || process.arch === "arm64")(
  "a module that only computes is run by the first function that reads its table",
  async () => {
    const llvm = await emit(computes);
    // The group's run and the module's place exist.
    const run = definition(llvm, "_x25_lazy_0");
    expect(run).not.toBe("");
    expect(definition(llvm, "_x25_lazy_at_\\d+")).not.toBe("");
    // The run stays out of line: a guard is a flag test and a call.
    expect(run.split("\n")[0]).toMatch(/\) noinline cold /);
    // The reader checks the group's flag once, ahead of its loop, and the
    // loop itself calls nothing of the group.
    const total = definition(llvm, "total");
    expect(total).toMatch(/_x25_lazy_0/);
    expect(total.match(/call [^\n]*_x25_lazy_0\(/g)).toHaveLength(1);
  },
);

test.runIf(process.arch === "x64" || process.arch === "arm64")(
  "a module that prints while it loads keeps its place, and so does its code",
  async () => {
    const llvm = await emit(`${computes}console.log("table loaded");\n`);
    expect(llvm).not.toMatch(/_x25_lazy_/);
  },
);
