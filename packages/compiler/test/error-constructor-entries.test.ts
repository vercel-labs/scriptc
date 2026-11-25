import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

async function llvmOf(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-error-entries-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const lowered = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!lowered.ok)
      throw new Error(lowered.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return emitLlvmModule(deserializeModule(await readFile(outPath, "utf8")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** How many call sites of a runtime entry the module holds. */
function calls(ll: string, symbol: string): number {
  return (ll.match(new RegExp(`call (?:ptr|void) @${symbol}\\(`, "g")) ?? []).length;
}

test("a string message, or none, takes the typed error constructors", async () => {
  const ll = await llvmOf(`
class Failure extends Error {
  constructor(message: string) {
    super(message);
  }
}
class Silent extends TypeError {
  constructor() {
    super();
  }
}
const text = ["a", "b"].join("");
const errors: Error[] = [
  new Error("literal"),
  new Error(text),
  new Error(\`template \${text}\`),
  new Error(),
  new Error(undefined),
  new RangeError("range"),
  Error("called"),
  new Failure("failure"),
  new Silent(),
];
console.log(errors.length);
`);
  expect(ll).not.toContain("@scr_error_new_options(");
  expect(ll).not.toContain("@scr_error_init_options(");
  // Seven constructions through `new` and the call form: a string message
  // is passed as it is, and an absent or undefined one as null.
  expect(calls(ll, "scr_error_new")).toBe(7);
  expect(ll).toMatch(/call ptr @scr_error_new\(i32 0, ptr null\)/);
  expect(ll).toMatch(/call ptr @scr_error_new\(i32 2, ptr [%@]/);
  expect(ll).toMatch(/call void @scr_error_init\(ptr %\S+, i32 0, ptr %\S+\)/);
  expect(ll).toMatch(/call void @scr_error_init\(ptr %\S+, i32 1, ptr null\)/);
});

test("an options argument or a message that is not a string keeps the checked constructors", async () => {
  const ll = await llvmOf(`
class Forwarding extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
  }
}
class Implicit extends Error {}
const count: any = 3;
const maybe: string | undefined = count > 2 ? "set" : undefined;
const errors: Error[] = [
  new Error("with options", { cause: 1 }),
  new Error(count),
  new Error(maybe),
  new Forwarding("forwarded"),
  new Implicit("implicit"),
];
console.log(errors.length);
`);
  expect(calls(ll, "scr_error_new_options")).toBe(3);
  // Forwarding's super() and the base of Implicit's inherited constructor.
  expect(calls(ll, "scr_error_init_options")).toBe(2);
  expect(calls(ll, "scr_error_new")).toBe(0);
  expect(calls(ll, "scr_error_init")).toBe(0);
});
