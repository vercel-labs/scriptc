// A computed import() whose specifier the compiler can bound becomes one
// literal edge per value, so the loads of Node builtins compile natively.
// `require` has no binding in an ES module, and Node throws for every read
// of it — including `typeof`, which answers "undefined".
const importNodeModule = (specifier: string): Promise<unknown> => import(specifier);
const NODE_PATH = "node:" + "path";

async function main(): Promise<void> {
  const os = (await importNodeModule("node:os")) as { EOL: string };
  const path = (await importNodeModule(NODE_PATH)) as { posix: { join(a: string, b: string): string } };
  console.log(JSON.stringify(os.EOL), path.posix.join("a", "b"));
  try {
    const r = require("node:fs") as { existsSync(p: string): boolean };
    console.log("required", typeof r.existsSync);
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
  console.log(typeof require);
}
void main();
export {};
