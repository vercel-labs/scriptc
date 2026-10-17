import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";

/** Names of the functions whose bodies call `callee`. */
async function callersOf(source: string, callee: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-method-mutations-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    return mod.functions
      .filter((fn) => JSON.stringify(fn.body).includes(`"callee":"${callee}"`))
      .map((fn) => fn.name);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const reporter = `
type ErrorCallback = (message: string) => void;
class Scanner {
  private onError: ErrorCallback | undefined = undefined;
  setOnError(onError: ErrorCallback | undefined): void { this.onError = onError; }
  fail(message: string): void { if (this.onError !== undefined) this.onError(message); }
}
class Reporter {
  count = 0;
  onError(message: string): void { this.count = this.count + message.length; }
}
const reporter = new Reporter();
const scanner = new Scanner();
scanner.setOnError((message) => reporter.onError(message));
scanner.fail("bad");
console.log(reporter.count);
`;

test("a callback field sharing a method's name leaves the method's calls direct", async () => {
  expect(await callersOf(reporter, "%dyn.class.properties")).toEqual([]);
});

test("an interface-typed write that can reach a method keeps checked dispatch", async () => {
  const relabeled = `${reporter}
interface Errors { onError: (message: string) => void; }
function silence(target: Errors): void { target.onError = () => {}; }
silence(reporter);
reporter.onError("again");
console.log(reporter.count);
`;
  expect(await callersOf(relabeled, "%dyn.class.properties")).not.toEqual([]);
});

// A method call the census leaves alone stays a direct call from the
// module's top level (`%init.0`); a replaceable method is called through a
// method value instead.
const counter = `
class Counter {
  n = 0;
  bump(): void { this.n = this.n + 1; }
}
const counter = new Counter();
counter.bump();
`;

test("a key asserted to be a number leaves method calls direct", async () => {
  const asserted = `${counter}
function clear(slots: (Counter | null)[], at: number | undefined): void {
  slots[at as number] = null;
  slots[at!] = null;
}
clear([counter], 0);
console.log(counter.n);
`;
  expect(await callersOf(asserted, "%Counter.bump")).toContain("%init.0");
});

test("a literal key keeps its names under a wider assertion", async () => {
  const literal = `${counter}
function put(target: Record<string, unknown>, key: "a" | "b"): void { target[key as string] = 1; }
put({}, "a");
console.log(counter.n);
`;
  expect(await callersOf(literal, "%Counter.bump")).toContain("%init.0");
});

test("a key that can be any string makes method calls checked", async () => {
  const anyKey = `${counter}
function put(target: Record<string, unknown>, key: string): void { target[key] = 1; }
put({}, process.argv.length > 99 ? "bump" : "a");
console.log(counter.n);
`;
  expect(await callersOf(anyKey, "%Counter.bump")).not.toContain("%init.0");
});
