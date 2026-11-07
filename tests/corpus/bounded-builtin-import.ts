// A computed import() whose specifier the compiler can bound becomes one
// literal edge per value, so the loads of Node builtins compile natively. The
// bound covers a literal, a const, `+`, a template span, a `?:`, a `??`/`||`
// union and a parameter of a module-local function whose every call passes a
// bound value.
// `require` has no binding in an ES module, and Node throws for every read
// of it — including `typeof`, which answers "undefined".
const importNodeModule = (specifier: string): Promise<unknown> => import(specifier);
const NODE_PATH = "node:" + "path";
const maybe = "node:path" as string | undefined;
const flag = process.argv.length > 2;
const name = "path";

interface PathModule {
  sep: string;
  posix: { join(a: string, b: string): string };
}
interface OsModule {
  EOL: string;
}

async function main(): Promise<void> {
  const os = (await importNodeModule("node:os")) as OsModule;
  const path = (await importNodeModule(NODE_PATH)) as PathModule;
  console.log(JSON.stringify(os.EOL), path.posix.join("a", "b"));
  const picked = (await import(flag ? "node:os" : "node:path")) as PathModule;
  console.log("picked", picked.sep);
  const defaulted = (await import(maybe ?? "node:os")) as PathModule;
  console.log("defaulted", defaulted.sep);
  const orDefault = (await import(maybe || "node:path")) as PathModule;
  console.log("or", orDefault.sep);
  const spanned = (await import(`node:${name}`)) as PathModule;
  console.log("span", spanned.posix.join("c", "d"));
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
