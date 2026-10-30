// A method or call signature of an interface whose parameter is typed `any`
// (directly, or through an alias that resolves to `any`) takes whatever the
// caller passes, as a function type's `any` parameter already does: the
// interface compiles, and implementations receive the checked-dynamic value.

type Loose = any;

interface Tool {
  name: string;
  execute(id: string, params: any, extra?: Loose): Promise<string>;
  describe(value: Loose): string;
}

interface Formatter {
  (value: any): string;
}

const tools: Tool[] = [
  {
    name: "count",
    execute: async (id, params) => `${id} has ${Object.keys(params ?? {}).length} keys`,
    describe: (value) => `count(${Array.isArray(value) ? "array" : typeof value})`,
  },
];

const format: Formatter = (value) => (typeof value === "number" ? value.toFixed(1) : String(value));

async function main(): Promise<void> {
  const inputs: unknown[] = [{ a: 1, b: [2, 3] }, "text", 42, null, [1, 2]];
  for (const tool of tools) {
    for (const input of inputs) {
      console.log(tool.name, await tool.execute("call", input), tool.describe(input));
    }
    console.log(tool.name, await tool.execute("extra", { k: true }, { more: "yes" }));
  }
  console.log(format(3), format("x"), format(undefined));
}

main().catch((e: unknown) => console.log("failed", e instanceof Error ? e.message : String(e)));
