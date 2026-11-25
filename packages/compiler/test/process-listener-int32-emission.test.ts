import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function classLayout(listeners: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-process-listener-int32-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(
      entry,
      `
class P {
  kind: number;
  pos: number;
  next: P | undefined;
  constructor(kind: number, pos: number) {
    this.kind = kind | 0;
    this.pos = pos | 0;
    this.next = undefined;
  }
}
const n = process.argv.length;
const p = new P(n, n * 2);
p.next = new P(1, 2);
if (n > 100) console.log(p as unknown);
const listener = (): void => {
  console.log("signal");
};
if (n > 100) {
  ${listeners}
}
console.log(p.kind + p.pos);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const llvm = await readFile(outPath, "utf8");
    return /^%sc_o_P = type \{[^}]*\}/m.exec(llvm)?.[0] ?? "";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// uncaughtException listeners need @types/node, which this temporary
// project lacks; the int32-slots unit test covers their helpers.
test.for([
  [
    "signals",
    `process.on("SIGINT", listener);\n  process.once("SIGTERM", listener);\n  process.off("SIGINT", listener);`,
  ],
  [
    "unhandledRejection",
    `process.on("unhandledRejection", listener);\n  process.off("unhandledRejection", listener);`,
  ],
  [
    "rejectionHandled",
    `process.on("rejectionHandled", listener);\n  process.off("rejectionHandled", listener);`,
  ],
  ["warning", `process.on("warning", listener);\n  process.off("warning", listener);`],
] as const)(
  "%s listeners keep int32 fields of classes that reach dynamic code",
  async ([, listeners]) => {
    const layout = await classLayout(listeners);
    expect(layout).toMatch(/^%sc_o_P = type \{ i64, i32, i32, ptr/);
  },
);
