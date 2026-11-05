import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import { emitLlvmModule } from "./emitter.js";
import { REPR_REPORT_HEADER } from "./repr-report.js";

const saved = process.env["SCRIPTC_REPR_REPORT"];
afterEach(() => {
  if (saved === undefined) delete process.env["SCRIPTC_REPR_REPORT"];
  else process.env["SCRIPTC_REPR_REPORT"] = saved;
});

test("the representation report names each slot's storage and why a number stays a double", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-repr-report-"));
  try {
    const entry = join(dir, "main.ts"),
      outPath = join(dir, "main.ir.json"),
      report = join(dir, "repr.tsv");
    await writeFile(
      entry,
      `
class Box {
  id: number;
  hits: number;
  items: number[];
  constructor(id: number, items: number[]) { this.id = id | 0; this.hits = 0; this.items = items; }
}
function scale(value: number, by: number = 2): number { return (value * by) | 0; }
function half(value: number): number { return value / 2; }
const boxes: Box[] = [];
for (let i = 0; i < 4; i++) boxes.push(new Box(i, [i, i + 1]));
for (const b of boxes) b.hits++;
console.log(scale(boxes[1]!.id), scale(3, 4), half(boxes.length), boxes[2]!.items.length, boxes[3]!.hits);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    process.env["SCRIPTC_REPR_REPORT"] = report;
    emitLlvmModule(mod);
    const lines = (await readFile(report, "utf8")).trimEnd().split("\n");
    expect(lines[0]).toBe(REPR_REPORT_HEADER);
    const rows = lines.slice(1).map((line) => line.split("\t"));
    const row = (kind: string, owner: string, name: string) =>
      rows.find((r) => r[0] === kind && r[1] === owner && r[2] === name);
    expect(row("field", "Box", "id")?.slice(3, 5)).toEqual(["f64", "i32"]);
    // `++` on a field keeps it a double, and the report says so.
    expect(row("field", "Box", "hits")?.[4]).toBe("double");
    expect(row("field", "Box", "hits")?.[5]).not.toBe("");
    expect(row("field", "Box", "items")?.slice(3, 5)).toEqual(["array<f64>", "ptr"]);
    // Both calls of `scale` take its variant, whose defaulted parameter is
    // a number: the one that omits it passes the default.
    expect(row("param", "scale", "by")).toBeUndefined();
    expect(row("param", "scale.nativeNumber", "value")?.[4]).toBe("i32");
    expect(row("param", "scale.nativeNumber", "by")?.slice(3, 5)).toEqual(["f64", "i32"]);
    // An array length may exceed the int32 range.
    expect(row("param", "half", "value")?.[4]).toBe("double");
    expect(row("param", "half", "value")?.[5]).toMatch(/^argument in .* is not int32$/);
    expect(row("return", "half", "")?.slice(4)).toEqual(["double", "return is not int32"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
