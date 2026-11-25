// Bounded dynamic imports of the program's OWN modules (SPEC §5.1, §4.1 step
// 2): each value of a bounded specifier becomes one literal edge, so the
// module compiles natively and a second import answers the module cache —
// one instance, however many static and dynamic edges reach it. A value
// resolves to exactly the file it names, the way Node resolves it: a missing
// `.js` variant rejects with ERR_MODULE_NOT_FOUND at run time instead of
// falling back to the TypeScript source next to it.
import { loads } from "./bounded-program-import/state.ts";

interface Loaded {
  name: string;
  id(): string;
}

// A parameter of a module-local function every call of which passes a bound
// value, spliced into a template: the site has two bounded values, "a" and
// "b".
async function load(name: string): Promise<Loaded> {
  return (await import(`./bounded-program-import/${name}.ts`)) as Loaded;
}

async function main(): Promise<void> {
  const a = await load("a");
  console.log(a.name, a.id());
  const b = await load("b");
  console.log(b.name, b.id());
  const again = await load("a");
  console.log("repeat", again.name, again.id());

  // state.ts is reached statically and dynamically: one instance.
  const state = await import("./bounded-program-import/state.ts");
  console.log("one instance", state.loads === loads, loads.join(","));

  // Node resolves the specifier as written; it never rewrites `.js` to `.ts`,
  // so this names no file even though a.ts sits next to it.
  const jsVariant = "./bounded-program-import/a.js";
  try {
    await import(jsVariant);
    console.log("loaded the .js variant");
  } catch (e) {
    const err = e as Error & { code?: string };
    console.log(err.code, err.message.includes("a.js"));
  }

  const absent = "./bounded-program-import/absent.ts";
  try {
    await import(absent);
    console.log("loaded the absent module");
  } catch (e) {
    const err = e as Error & { code?: string };
    console.log(err.code, err.message.includes("absent.ts"));
  }

  console.log("loads", loads.join(","));
}
void main();
