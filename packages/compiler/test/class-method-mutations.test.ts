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
