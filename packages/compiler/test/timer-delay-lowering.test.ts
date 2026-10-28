import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrExpr } from "../src/ir/ir.js";

/** The delay argument of every setTimeout/setInterval libCall in the module. */
async function timerDelays(source: string): Promise<IrExpr[]> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-timer-delays-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const delays: IrExpr[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const node = value as { kind?: unknown; fn?: unknown; args?: IrExpr[] };
      if (
        node.kind === "libCall" &&
        typeof node.fn === "string" &&
        /^timers\.set(Timeout|TimeoutHandle|Interval)$/.test(node.fn)
      )
        delays.push(node.args![1]!);
      for (const child of Object.values(value)) visit(child);
    };
    visit(mod.functions);
    return delays;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("number delays pass to the timer unchanged", async () => {
  const delays = await timerDelays(
    `function arm(ms: number): void {
      setTimeout(() => console.log("a"), ms);
      setTimeout(() => console.log("b"), 5);
      const id = setInterval(() => clearInterval(id), ms);
    }
    arm(1);
    export {};
    `,
  );
  expect(delays.map((delay) => delay.kind)).toEqual(["varRef", "numLit", "varRef"]);
  for (const delay of delays) expect(delay.type).toEqual({ kind: "f64" });
});

test("a number | undefined delay converts with ToNumber", async () => {
  const delays = await timerDelays(
    `interface Options { ms?: number }
    function arm(options: Options): void {
      setTimeout(() => console.log("a"), options.ms);
      const id = setInterval(() => clearInterval(id), options.ms);
    }
    arm({});
    export {};
    `,
  );
  expect(delays).toHaveLength(2);
  for (const delay of delays) {
    // undefined is NaN, the omitted delay; a number passes through.
    expect(delay).toMatchObject({
      kind: "ternary",
      type: { kind: "f64" },
      cond: { kind: "unionIsTag" },
      then: { kind: "bin", op: "/" },
      else_: { kind: "unionNarrow", type: { kind: "f64" } },
    });
  }
});
