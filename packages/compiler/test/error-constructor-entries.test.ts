import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

async function llvmOf(source: string, targetTriple?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-error-entries-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const lowered = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!lowered.ok)
      throw new Error(lowered.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return emitLlvmModule(
      deserializeModule(await readFile(outPath, "utf8")),
      targetTriple === undefined ? {} : { targetTriple },
    );
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

test("the views of program error classes are a table only the runtime's reader names", async () => {
  const source = `
class AppError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
class Quiet extends TypeError {}
try {
  throw new AppError("denied", 403);
} catch (error) {
  if (error instanceof AppError) console.log(error.status, new Quiet("q").message);
}
`;
  const elf = await llvmOf(source, "x86_64-unknown-linux-gnu");
  // Nothing registers a view at start-up: the program defines the table the
  // runtime reads when it boxes an error, one row per class and a null row.
  expect(elf).not.toContain("scr_error_register_dyn");
  expect(elf).toMatch(
    /^@sc_error_views = internal constant \[3 x \{ ptr, ptr \}\] \[.*@sc_error_view_0.*@sc_error_view_1.*zeroinitializer\], section "\.data\.rel\.ro\.sc_error_views"$/m,
  );
  expect(elf).toMatch(
    /^@scr_error_dyn_types = constant ptr @sc_error_views, section "\.data\.rel\.ro\.scr_error_dyn_types"$/m,
  );
  // No compiled code names the table or a view, so the linker can drop them
  // with what only they reach: on ELF each is a section of its own.
  const uses = (ll: string, symbol: string): number =>
    ll.split("\n").filter((line) => line.includes(`@${symbol}`) && !line.startsWith("@")).length;
  expect(uses(elf, "scr_error_dyn_types")).toBe(0);
  expect(uses(elf, "sc_error_views")).toBe(0);
  for (const view of ["sc_error_view_0", "sc_error_view_1"]) {
    expect(elf).toContain(`define internal ptr @${view}(ptr %v) #0 section ".text.${view}" {`);
    expect(uses(elf, view)).toBe(1);
  }
  const snapshots = elf.match(/^define internal ptr @sc_ldr_\d+_materialize\(.*$/gm) ?? [];
  expect(snapshots.length).toBe(2);
  for (const line of snapshots)
    expect(line).toMatch(/ #0 section "\.text\.sc_ldr_\d+_materialize" \{/);

  // Mach-O is dead-stripped by symbol and takes no ELF section names.
  const macho = await llvmOf(source, "arm64-apple-macosx14.0.0");
  expect(macho).toContain("@scr_error_dyn_types = constant ptr @sc_error_views");
  expect(macho).not.toContain(' section "');
});

test("a program without error classes defines no view table", async () => {
  const ll = await llvmOf(
    `try { throw new RangeError("r"); } catch (error) { if (error instanceof Error) console.log(error.message); }`,
    "x86_64-unknown-linux-gnu",
  );
  expect(ll).not.toContain("scr_error_dyn_types");
  expect(ll).not.toContain(' section "');
});
