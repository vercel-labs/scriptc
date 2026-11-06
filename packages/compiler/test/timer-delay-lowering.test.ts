import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrExpr } from "../src/ir/ir.js";

type TimerCall = Extract<IrExpr, { kind: "libCall" }>;

/** Every setTimeout/setInterval libCall in the module. */
async function timerCalls(source: string): Promise<TimerCall[]> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-timer-delays-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const calls: TimerCall[] = [];
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
        calls.push(node as TimerCall);
      for (const child of Object.values(value)) visit(child);
    };
    visit(mod.functions);
    return calls;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The delay argument of every setTimeout/setInterval libCall in the module. */
async function timerDelays(source: string): Promise<IrExpr[]> {
  return (await timerCalls(source)).map((call) => call.args[1]!);
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
  // A literal delay in range passes as it is. A number variable passes
  // through timers.userDelay, which emits Node's Timeout warning when the
  // timer sets the delay to 1; its second argument is 0 for setTimeout and 1
  // for setInterval.
  expect(delays.map((delay) => delay.kind)).toEqual(["libCall", "numLit", "libCall"]);
  for (const delay of delays) expect(delay.type).toEqual({ kind: "f64" });
  expect(delays[0]).toMatchObject({
    fn: "timers.userDelay",
    args: [{ kind: "varRef" }, { kind: "numLit", value: 0 }],
  });
  expect(delays[2]).toMatchObject({
    fn: "timers.userDelay",
    args: [{ kind: "varRef" }, { kind: "numLit", value: 1 }],
  });
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
    // undefined is NaN, the omitted delay, and warns nothing; a number
    // passes through timers.userDelay.
    expect(delay).toMatchObject({
      kind: "ternary",
      type: { kind: "f64" },
      cond: { kind: "unionIsTag" },
      then: { kind: "bin", op: "/" },
      else_: {
        kind: "libCall",
        fn: "timers.userDelay",
        args: [{ kind: "unionNarrow", type: { kind: "f64" } }, { kind: "numLit" }],
      },
    });
  }
});

test("an imported timer call stays real through an untyped delay", async () => {
  const calls = await timerCalls(
    `import { setTimeout as realSetTimeout, setInterval as realSetInterval } from "node:timers";
    function arm(delay: any): void {
      realSetTimeout(() => console.log("a"), delay);
      realSetInterval(() => console.log("b"), delay);
      setTimeout(() => console.log("c"), delay);
    }
    arm(1);
    export {};
    `,
  );
  // An untyped delay waits in a hidden local, so the call sits inside a
  // seqExpr; the callee still decides whether mock.timers routes it.
  expect(calls.map((call) => call.realTimer)).toEqual([true, true, undefined]);
  expect(calls[0]).toMatchObject({ fn: "timers.setTimeout" });
  expect(calls[1]).toMatchObject({ fn: "timers.setInterval" });
  expect(calls[2]).toMatchObject({ fn: "timers.setTimeout" });
});
