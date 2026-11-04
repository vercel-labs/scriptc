// Overload sets held as values. JavaScript stores ONE function for an
// overload set; each call resolves its overload statically and converts the
// result back to that overload's type.
import type { Model, Registry } from "./registry.ts";

// 1. A class's overload set reached through a type-only class instance
//    type, inside a callback's context parameter (the extension-API shape).
interface Context {
  name: string;
  registry: Registry;
}
type Handler = (ctx: Context) => Promise<string[]>;

function makeHandler(): Handler {
  return async (ctx) => {
    const byId = await ctx.registry.runtime.getAuth("anthropic");
    const byModel = await ctx.registry.runtime.getAuth({ provider: "openai", id: "gpt" }, { env: "ci" });
    return [ctx.name, String(byId), String(byModel)];
  };
}

const runtime = {
  async getAuth(target: string | Model, overrides?: { env?: string }): Promise<string | undefined> {
    if (typeof target === "string") return target === "none" ? undefined : `id:${target}:${overrides?.env ?? "-"}`;
    return `model:${target.provider}/${target.id}:${overrides?.env ?? "-"}`;
  },
};
const ctx: Context = { name: "ctx", registry: { runtime } };

// 2. An overload set as a callback parameter type and as a type alias.
type Format = { (value: string): string; (value: number): string };
function showBoth(format: Format): string {
  return `${format("a")} ${format(2)}`;
}
const tagged: Format = (value: string | number) => `<${typeof value}:${value}>`;

// 3. Results convert to the resolved overload's type: a string overload
//    and a number overload share one stored function.
type Parse = { (text: string): number; (value: number): string };
const parse: Parse = (input: any): any => (typeof input === "string" ? input.length : `#${input}`);
function useParse(p: Parse): string {
  const n: number = p("four");
  const s: string = p(7);
  return `${n + 1} ${s.toUpperCase()}`;
}

// 4. An overloaded interface member read as a value, and a class method
//    bound as a value, called through the overload set.
interface Picker {
  pick(kind: "s"): string;
  pick(kind: "n"): number;
}
const picker: Picker = {
  pick(kind: "s" | "n"): any {
    return kind === "s" ? "str" : 41;
  },
};
const pick = picker.pick;

class Counter {
  readonly base: number;
  constructor(base: number) {
    this.base = base;
  }
  add(x: string): string;
  add(x: number): number;
  add(x: string | number): string | number {
    return typeof x === "string" ? `${x}${this.base}` : x + this.base;
  }
}
const counter = new Counter(10);
const add = counter.add.bind(counter);

// 5. A function with overload declarations and an arrow fill an array of
//    overload-set slots.
function describe(value: string): string;
function describe(value: number): string;
function describe(value: string | number): string {
  return `${typeof value}=${value}`;
}
const formats: Format[] = [describe, tagged, (value: string | number) => `[${value}]`];

async function main(): Promise<void> {
  console.log((await makeHandler()(ctx)).join(" | "));
  console.log(await ctx.registry.runtime.getAuth("none"));
  console.log(showBoth(tagged), showBoth(describe));
  console.log(useParse(parse));
  console.log(pick("s").toUpperCase(), pick("n") + 1, typeof pick);
  console.log(add("n"), add(5) * 2, typeof add);
  for (const format of formats) console.log(format("x"), format(3));
  console.log(formats.length, formats[0] === describe);
}

await main();

export default makeHandler();
