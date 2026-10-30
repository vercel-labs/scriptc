import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile, deserializeModule } from "../src/index.js";
import { everyStmtList } from "../src/ir/traverse.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { deserializeModuleBytes, serializeModule } from "../src/ir/serialize.js";

async function matchesNode(
  source: string,
  fileName = "main.ts",
  modules: Record<string, string> = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-property-admission-"));
  try {
    const entry = join(dir, fileName);
    writeFileSync(entry, source);
    for (const [name, contents] of Object.entries(modules))
      writeFileSync(join(dir, name), contents);
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const native = spawnSync(result.binaryPath, { encoding: "utf8", timeout: 30_000 });
    const oracle = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 30_000 });
    expect(native.error).toBeUndefined();
    expect(oracle.error).toBeUndefined();
    expect(oracle.status).toBe(0);
    expect({
      status: native.status,
      signal: native.signal,
      stdout: native.stdout,
      stderr: native.stderr,
    }).toEqual({
      status: oracle.status,
      signal: oracle.signal,
      stdout: oracle.stdout,
      stderr: oracle.stderr,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("class presence does not compile an unobserved method body", async () => {
  await matchesNode(`
class Presence { unused() { return eval("1 + 1"); } }
const instance = new Presence();
let reads = 0;
function receiver(): any { reads++; return instance; }
function probe(value: any, key: string) {
  console.log("unused" in value, key in value, !("unused" in value), "missing" in value);
}
probe(receiver(), ["un", "used"].join(""));
probe(receiver(), "unused");
console.log(reads);
`);
});

test("native class inspection follows default, null, and restored prototypes", async () => {
  await matchesNode(`
class Cell {
  value: number | boolean | undefined;
  constructor(value: number | boolean | undefined) { this.value = value; }
}
class Child extends Cell {}
function view(cell: Cell): any { return cell; }
const cell = view(new Cell(5));
const prototype = Object.getPrototypeOf(cell);
console.log(cell, [cell], Object.keys(cell));
Object.setPrototypeOf(cell, null);
console.log(cell);
Object.setPrototypeOf(cell, {});
console.log(cell);
Object.setPrototypeOf(cell, prototype);
console.log(cell, view(new Child(true)));
class Empty {}
const empty: any = new Empty();
console.log(empty);
Object.setPrototypeOf(empty, null);
console.log(empty);
console.log(new (class { value = 7; })());
console.log(new (class {})());
`);
});

test("inherited native property bags specialize the complete capsule receiver", async () => {
  const source = `
class Base { value = 1; }
class Child extends Base {
  static { Object.defineProperty(Child.prototype, "mark", { value: "child" }); }
}
class Leaf extends Child {
  static { Object.defineProperty(Leaf.prototype, "mark", { value: "leaf" }); }
}
function read(value: Base) { const boxed: any = value; return boxed.mark; }
console.log(read(new Child()), read(new Leaf()));
`;
  const dir = mkdtempSync(join(tmpdir(), "scriptc-property-receiver-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    writeFileSync(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const module = deserializeModule(readFileSync(output, "utf8"));
    const child = module.classes!.find((cls) => cls.jsName === "Child")!;
    const leaf = module.classes!.find((cls) => cls.jsName === "Leaf")!;
    expect(child.nativePropertyBagHelper).toBeDefined();
    const bag = module.functions.find((fn) => fn.name === child.nativePropertyBagHelper)!;
    everyStmtList(bag.body, {
      stmt: () => true,
      expr: (expr) => {
        expect(expr.kind === "libCall" && expr.fn === "dyn.objCreate").toBe(false);
        return true;
      },
    });
    const helper = module.functions.find((fn) => fn.name === child.instancePrototypeHelper)!;
    let selectsLeaf = false;
    everyStmtList(helper.body, {
      stmt: () => true,
      expr: (expr) => {
        if (expr.kind === "instanceOf" && expr.className === leaf.name) {
          expect(expr.value.kind).toBe("varRef");
          expect(expr.value.type).toEqual({ kind: "object", className: child.name });
          selectsLeaf = true;
        }
        return true;
      },
    });
    expect(selectsLeaf).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await matchesNode(source);
});

test("native class aliases share explicit prototypes and preserve accessor receivers", async () => {
  await matchesNode(`
class Item {
  value = 2;
  get doubled() { return this.value * 2; }
  set changed(value: number) { this.value = value + 1; }
  method() { return this.value; }
}
function box(value: Item): any { return value; }
function keys(value: any) { const result: string[] = []; for (const key in value) result.push(key); return result.join(","); }
const item = new Item();
const first = box(item), second = box(item);
const initial = Object.getPrototypeOf(first);
console.log("default", first.constructor === Item, first.doubled, "method" in second, keys(second));
first.changed = 3;
console.log("setter", item.value);
const symbol = Symbol("inherited");
const prototype = { constructor: "replacement", extra: 7, get doubled() { return this.value * 3; }, set changed(value: number) { this.value = value + 2; }, value: 0 };
Object.defineProperty(prototype, symbol, { value: 11, configurable: true });
Object.setPrototypeOf(first, prototype);
console.log("replacement", Object.getPrototypeOf(second) === prototype, second.constructor, second.doubled, "method" in second, second[symbol], symbol in second, keys(second));
const receiver = { value: 10 };
console.log("reflect", Reflect.get(second, "doubled", receiver), Reflect.set(second, "changed", 5, receiver), receiver.value, item.value);
Object.setPrototypeOf(second, null);
console.log("null", Object.getPrototypeOf(first) === null, first.constructor, first.doubled, "method" in first, symbol in first, keys(first));
Object.setPrototypeOf(first, Object.prototype);
console.log("object", Object.getPrototypeOf(second) === Object.prototype, "method" in second, "doubled" in second, "toString" in second);
Object.setPrototypeOf(second, initial);
Object.preventExtensions(first);
console.log("same", Object.setPrototypeOf(second, initial) === second, second.constructor === Item, second.doubled);
try { Object.setPrototypeOf(second, null); } catch (error) { console.log("refused", error instanceof TypeError); }
console.log("unchanged", Object.getPrototypeOf(first) === initial, item.value);
`);
});

test("native accessor record prototypes preserve Get and Set receivers without layout writes", async () => {
  await matchesNode(`
class Box { value = 1; }
const box = new Box();
let calls = 0;
const prototype = {
  get token(): boolean { calls++; return true; },
  set token(value: boolean) { calls++; console.log("setter", value); },
  get readonly(): number { return 7; },
  set throwing(value: number) { throw new Error("setter " + value); },
};
function checked(value: unknown): any { return value; }
const target = checked(box);
Object.setPrototypeOf(target, prototype);
console.log("get", target.token, Reflect.get(target, "readonly"));
target.token = true;
Object.freeze(box);
target.token = false;
console.log("frozen", Object.hasOwn(target, "token"), box.value);
const other = {};
console.log("reflect", Reflect.get(target, "token", other), Reflect.set(target, "token", true, other));
console.log("readonly", Reflect.set(target, "readonly", 9, other), Object.hasOwn(other, "readonly"));
try { Reflect.set(target, "throwing", 3, other); } catch (error) { console.log((error as Error).message); }
console.log("unchanged", Object.keys(other).length, box.value);
const plain = checked({});
Object.setPrototypeOf(plain, prototype);
console.log("plain get", plain.token);
plain.token = true;
console.log("plain own", Object.hasOwn(plain, "token"), calls);
`);
});

test("native property stores retain operation semantics through serialized IR", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-property-operations-"));
  try {
    for (const strict of [false, true]) {
      const entry = join(dir, "main.cts"),
        output = join(dir, "main.ir.json");
      writeFileSync(
        entry,
        `${strict ? '"use strict";' : ""}
const item: { value?: number } = { value: 1 };
item.value = undefined;
delete item.value;
class Box { value = 1; constructor() { this.value = 2; } }
console.log(item.value, new Box().value);
`,
      );
      const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      const module = deserializeModule(readFileSync(output, "utf8"));
      const recordOps: string[] = [],
        classOps: string[] = [];
      for (const fn of module.functions)
        everyStmtList(fn.body, {
          expr: () => true,
          stmt: (stmt) => {
            if (stmt.kind === "recordSet" && stmt.field === "value")
              recordOps.push(stmt.propertyOp ?? "missing");
            if (stmt.kind === "fieldSet" && stmt.field === "value")
              classOps.push(stmt.propertyOp ?? "missing");
            return true;
          },
        });
      expect(recordOps).toContain(strict ? "set" : "setSloppy");
      expect(recordOps).toContain(strict ? "delete" : "deleteSloppy");
      expect(classOps).toContain("define");
      expect(classOps).toContain("set");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("class field provenance survives lowering, inheritance, and serialization", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-class-provenance-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    writeFileSync(
      entry,
      `
const key = Symbol("key");
class Base {
  "#public" = 1;
  "%public" = 2;
  #secret = 3;
  private typedPrivate = 4;
  read(): number { return this.#secret + this.typedPrivate; }
}
class Child extends Base { ["%folded"] = 5; [key] = 6; }
const item: unknown = new Child();
console.log(item);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const module = deserializeModule(readFileSync(output, "utf8"));
    const child = module.classes!.find((cls) => cls.jsName === "Child")!;
    expect(child).toBeDefined();
    for (const name of ["#public", "%public", "%folded", "typedPrivate"])
      expect(child.fields.find((field) => field.name === name)?.visibility).toBeUndefined();
    expect(child.fields.find((field) => field.name === "#secret")?.visibility).toBe("private");
    expect(child.fields.find((field) => field.name === "%dynProperties")?.visibility).toBe(
      "internal",
    );
    expect(child.symbolFields).toHaveLength(1);
    expect(
      child.fields.find((field) => field.name === child.symbolFields![0]!.field)?.visibility,
    ).toBeUndefined();
    for (const pointerBits of [32, 64] as const) {
      const options = { pointerBits, wasi: pointerBits === 32, runtimeAbiMarker: false };
      const expected = emitLlvmModule(module, options);
      for (const compact of [false, true]) {
        const text = serializeModule(module, compact);
        for (const decoded of [
          deserializeModule(text),
          deserializeModuleBytes(Buffer.from(text)),
        ]) {
          expect(decoded.classes).toEqual(module.classes);
          expect(emitLlvmModule(decoded, options)).toEqual(expected);
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["EventTarget", "Event"])(
  "class exposure preserves the runtime-owned %s layout",
  async (runtimeBase) => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-runtime-class-layout-"));
    try {
      const entry = join(dir, "main.ts"),
        output = join(dir, "main.ir.json");
      const args = runtimeBase === "Event" ? '"event"' : "";
      writeFileSync(
        entry,
        `
class Base extends ${runtimeBase} { value = 1; }
class Child extends Base { extra = 2; }
class Other extends ${runtimeBase} { other = 3; }
console.log(new Child(${args}), new Other(${args}));
`,
      );
      const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      const module = deserializeModule(readFileSync(output, "utf8"));
      const root = module.classes!.find((cls) => cls.name === `%${runtimeBase}`)!;
      expect(root).toMatchObject({ runtime: true, fields: [] });
      const base = module.classes!.find((cls) => cls.jsName === "Base")!;
      const child = module.classes!.find((cls) => cls.jsName === "Child")!;
      const other = module.classes!.find((cls) => cls.jsName === "Other")!;
      for (const cls of [base, child, other])
        expect(cls.fields.find((field) => field.name === "%dynProperties")?.visibility).toBe(
          "internal",
        );
      expect(child.fields.slice(0, base.fields.length)).toEqual(base.fields);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.each(["main.mjs", "main.ts"])(
  "class presence retains exact-layout preparation and guarded stores in %s",
  async (fileName) => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-class-preparation-"));
    try {
      const entry = join(dir, fileName),
        output = join(dir, "main.ir.json");
      writeFileSync(
        entry,
        `
class Base { first = 1; #secret = 0; step() { this.#secret++; return this.first++; } }
class Child extends Base { second = 2; text = "old"; append() { return this.text += "new"; } }
const child = new Child();
console.log(child.step(), child.append());
/** @type {unknown} */ const value${fileName.endsWith(".ts") ? ": unknown" : ""} = new Child();
console.log(value);
`,
      );
      const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      const module = deserializeModule(readFileSync(output, "utf8"));
      for (const name of ["Base", "Child"]) {
        const cls = module.classes!.find((cls) => cls.jsName === name)!;
        expect(cls.tracksOwnFields).toBe(true);
        expect(cls.nativePropertyBagHelper).toBeDefined();
        const helper = module.functions.find((fn) => fn.name === cls.nativePropertyBagHelper)!;
        expect(helper.params[0]?.type).toEqual({ kind: "object", className: cls.name });
        expect(helper.returnType).toEqual({ kind: "dyn" });
      }
      const guards: string[] = [],
        privateUpdates: string[] = [];
      for (const fn of module.functions)
        everyStmtList(fn.body, {
          stmt: () => true,
          expr: (expr) => {
            if (
              expr.kind === "intrinsic" &&
              expr.name === "native.checkWrite" &&
              expr.args[1]?.kind === "strLit"
            )
              guards.push(expr.args[1].value);
            if (expr.kind === "fieldIncDec") privateUpdates.push(expr.field);
            return true;
          },
        });
      expect(guards).toEqual(expect.arrayContaining(["first", "second", "text"]));
      expect(guards).not.toContain("#secret");
      expect(privateUpdates).not.toContain("first");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.each([false, true])(
  "typed record/class integrity calls retain native ownership: alias=%s",
  async (alias) => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-native-integrity-admission-"));
    try {
      const entry = join(dir, "main.ts"),
        output = join(dir, "main.ir.json");
      const members = [
        "freeze",
        "seal",
        "preventExtensions",
        "isFrozen",
        "isSealed",
        "isExtensible",
      ];
      writeFileSync(
        entry,
        `
${alias ? members.map((member) => `const ${member} = Object.${member};`).join("\n") : ""}
class Box { value = 1; #secret = 2; read() { return this.#secret; } }
const record = { value: 1 };
const box = new Box();
${members
  .flatMap((member) =>
    ["record", "box"].map(
      (name) => `console.log(${alias ? member : `Object.${member}`}(${name}));`,
    ),
  )
  .join("\n")}
console.log(Object.freeze({ literal: 1 }).literal);
record.value = 2; box.value = 2;
console.log(record.value, box.value, box.read());
`,
      );
      const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      const module = deserializeModule(readFileSync(output, "utf8"));
      const operations: { name: string; receiver: string; result: string }[] = [];
      for (const fn of module.functions)
        everyStmtList(fn.body, {
          stmt: () => true,
          expr: (expr) => {
            if (
              expr.kind === "intrinsic" &&
              members.some((member) => expr.name === `native.${member}`)
            ) {
              expect(expr.args).toHaveLength(1);
              expect(expr.args[0]?.kind).toBe("varRef");
              operations.push({
                name: expr.name,
                receiver: expr.args[0]!.type.kind,
                result: expr.type.kind,
              });
            }
            return true;
          },
        });
      for (const member of members)
        for (const receiver of ["record", "object"])
          expect(operations).toContainEqual({
            name: `native.${member}`,
            receiver,
            result: member.startsWith("is") ? "bool" : "void",
          });
      expect(operations).toHaveLength(13);
      const cls = module.classes!.find((item) => item.jsName === "Box")!;
      expect(cls.tracksOwnFields).toBe(true);
      expect(cls.nativePropertyBagHelper).toBeDefined();
      for (const pointerBits of [32, 64] as const) {
        const llvm = emitLlvmModule(module, { pointerBits });
        for (const flags of [1, 3, 7]) {
          expect(llvm).toMatch(
            new RegExp(`call void @scr_native_object_restrict\\([^\\n]+i32 ${flags}\\)`),
          );
          expect(llvm).toMatch(
            new RegExp(`call zeroext i1 @scr_native_object_is_restricted\\([^\\n]+i32 ${flags}\\)`),
          );
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("readonly class views preserve identity without widening readonly records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-readonly-class-view-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    writeFileSync(
      entry,
      `
import { createHash } from "node:crypto";
class Counter { #value = 1; read(): number { return this.#value; } }
const frozen = Object.freeze(new Counter());
const structural: Readonly<Counter> = { read: () => 9 };
const record: Readonly<{ value: number }> = { value: 2 };
function relay(value: Readonly<Counter>): { read: () => number } { return value; }
const relayed = relay(frozen);
function shadowedReadonly() {
  type Readonly<T> = { value: number };
  const value: Readonly<Counter> = { value: 3 };
  return value;
}
const shadowed = shadowedReadonly();
class HashBox { hash = createHash("sha256"); }
const opaque: Readonly<HashBox> = { hash: createHash("sha256") };
console.log(frozen.read(), structural.read(), record.value, relayed.read(), shadowed.value,
  opaque.hash.digest("hex"));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const module = deserializeModule(readFileSync(output, "utf8"));
    for (const name of ["frozen", "structural", "relayed"])
      expect(module.globals?.find((global) => global.name === name)?.type.kind).toBe("dyn");
    for (const name of ["record", "shadowed", "opaque"])
      expect(module.globals?.find((global) => global.name === name)?.type.kind).toBe("record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("late symbol subclasses retain the frontend integrity refusal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-native-integrity-late-class-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      `
const key = Symbol("key");
class Base { value = 1; }
function run(): number {
  const base = new Base();
  Object.freeze(base);
  class Later extends Base { [key] = 1; }
  return new Later().value;
}
console.log(run());
`,
    );
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "main.ir.json"),
      outputKind: "ir",
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SC2020",
          message: expect.stringContaining("Object.freeze"),
        }),
      ]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("class declarations refuse distinct keys that would share a native slot", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-class-collision-"));
  try {
    const entry = join(dir, "main.ts");
    for (const fields of ['#x = 1; "#x" = 2;', '"#x" = 2; #x = 1;']) {
      writeFileSync(
        entry,
        `class Mixed { ${fields} read(): number { return this.#x; } } console.log(new Mixed().read());`,
      );
      const { coverage } = analyze(entry, {});
      expect(
        coverage.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "SC1090" && diagnostic.message.includes("distinct class fields"),
        ),
      ).toBe(true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native array integrity aliases preserve typed identity and argument order", async () => {
  await matchesNode(`"use strict";
const freeze = Object.freeze;
const seal = Object.seal;
const prevent = Object.preventExtensions;
const frozen = Object.isFrozen;
const sealed = Object.isSealed;
const extensible = Object.isExtensible;
const chained = freeze;
function localFreeze(value: string[]): readonly string[] {
  const local = chained;
  return local(value);
}
const values = ["first", "last"];
console.log("freeze", localFreeze(values) === values, frozen(values), sealed(values), extensible(values));
try { values[0] = "changed"; }
catch (error) { console.log("write", (error as Error).name); }
const fresh = Object.freeze(["fresh"]) as string[];
try { fresh[0] = "changed"; }
catch (error) { console.log("fresh", (error as Error).name, fresh[0]); }
const fixed = [1, 2];
console.log("prevent", prevent(fixed) === fixed, extensible(fixed), sealed(fixed), frozen(fixed));
fixed.pop();
console.log("seal", seal(fixed) === fixed, extensible(fixed), sealed(fixed), frozen(fixed));
fixed[0] = 7;
console.log("sealed contents", fixed.join(","));
let current = ["held"];
const held = current;
let order = "";
function target(): string[] { order += "target;"; return current; }
function extra(): void { order += "extra;"; current[0] = "before freeze"; current = ["replacement"]; }
// @ts-expect-error JavaScript evaluates ignored extra arguments.
const result: unknown = freeze(target(), extra());
console.log("order", order, result === held, held[0], frozen(held), frozen(current));
const untouched = ["kept"];
const marker: any = JSON.parse("{}");
function fail(): void { throw marker; }
try {
  // @ts-expect-error JavaScript evaluates ignored extra arguments.
  Object.freeze(untouched, fail());
} catch (error) { console.log("extra throw", error === marker, extensible(untouched)); }
const stored: any = freeze;
const direct: any = Object.freeze;
console.log("callable identity", stored === direct);
const escaped = ["stored"];
console.log("stored", stored(escaped) === escaped, frozen(escaped));
console.log("recreated capsule", Object.isFrozen(escaped), Object.isSealed(escaped));
console.log("primitives", freeze(7), seal("text"), prevent(null), frozen(undefined), sealed(1n), extensible(false));
console.log("direct primitives", Object.freeze(null), Object.seal(undefined), Object.preventExtensions(null));
function unit(): void { order += "unit;"; }
console.log("void", freeze(unit()) === undefined, Object.freeze(unit()) === undefined, frozen(unit()), order);
// @ts-expect-error JavaScript evaluates ignored extra arguments.
const ignoredUnits: unknown = freeze(current, null, undefined);
console.log("ignored units", ignoredUnits === current, frozen(current));
// @ts-expect-error JavaScript permits omitted arguments.
console.log("omitted", freeze() === undefined);
function shadow(): void {
  const Object = { freeze: (value: number): number => value + 1 };
  const local = Object.freeze;
  console.log("shadow", local(2));
}
shadow();
`);
});

test("native array integrity aliases retain imported provenance", async () => {
  await matchesNode(
    `
import { freeze, seal, prevent, frozen, sealed, extensible } from "./operations.mts";
const chain = freeze;
const values = [1, 2];
console.log("imported freeze", chain(values) === values, frozen(values));
const fixed = [3];
console.log("imported seal", seal(fixed) === fixed, sealed(fixed));
const closed: number[] = [];
console.log("imported prevent", prevent(closed) === closed, extensible(closed));
`,
    "main.mts",
    {
      "operations.mts": `
export const freeze = Object.freeze;
export const seal = Object.seal;
export const prevent = Object.preventExtensions;
export const frozen = Object.isFrozen;
export const sealed = Object.isSealed;
export const extensible = Object.isExtensible;
`,
    },
  );
});

test("native array integrity aliases preserve lexical initialization", async () => {
  await matchesNode(`"use strict";
let order = "";
function argument(): number[] { order += "argument;"; return [1]; }
function before(): void { freeze(argument()); }
function beforeValue(): any { return freeze; }
function beforeType(): void { console.log("type", typeof freeze); }
try { before(); }
catch (error) { console.log("global", (error as Error).name, order); }
try { beforeValue(); }
catch (error) { console.log("global value", (error as Error).name); }
try { beforeType(); }
catch (error) { console.log("global type", (error as Error).name); }
const freeze = Object.freeze;
beforeType();
before();
console.log("after", order);
function local(): void {
  const run = (): void => { seal(argument()); };
  try { run(); }
  catch (error) { console.log("local", (error as Error).name, order); }
  const seal = Object.seal;
  run();
}
local();
for (const operation = Object.preventExtensions; ; ) {
  const values = [1];
  console.log("loop", operation(values) === values, Object.isExtensible(values));
  break;
}
`);
});

test("native array integrity aliases preserve cyclic import initialization", async () => {
  await matchesNode(
    `
import { run } from "./consumer.mts";
export const freeze = Object.freeze;
run();
`,
    "main.mts",
    {
      "consumer.mts": `
import { freeze } from "./main.mts";
export function run(): void {
  const values = [1];
  console.log("cycle", freeze(values) === values, Object.isFrozen(values));
}
try { run(); }
catch (error) { console.log("cycle early", (error as Error).name); }
`,
    },
  );
});

test.each([false, true])(
  "native array statement deletion preserves ownership and strictness: %s",
  async (strict) => {
    await matchesNode(`${strict ? '"use strict";' : ""}
let values = ["first", "last"];
const held = values;
let order = "";
function receiver(): string[] { order += "receiver;"; return values; }
function key(): number { order += "key;"; values = ["replacement"]; return 0; }
delete receiver()[key()];
console.log("evaluation", order, held.length, Object.hasOwn(held, 0), held[1], values[0]);
held[-1] = "named";
console.log("own keys", Object.hasOwn(held, "-1"), Object.hasOwn(held, "1"), Object.hasOwn(held, "length"), Object.hasOwn(held, "missing"));
const computed: any = { toString(): string { order += "convert;"; return "-1"; } };
delete held[computed];
console.log("named", order, Object.hasOwn(held, "-1"), held.length);
const empty: string[] = [];
held[0] = empty[0];
console.log("undefined", Object.hasOwn(held, 0), held[0] === undefined);
delete held[0];
console.log("hole", Object.hasOwn(held, 0), held.length);
function restrict(value: any): void { Object.seal(value); }
restrict(held);
try { delete held[1]; console.log("sealed allowed"); }
catch (error) { console.log("sealed", (error as Error).name); }
delete held[3];
console.log("sealed contents", held.length, held[1]);
function freeze(value: any): void { Object.freeze(value); }
freeze(values);
try { delete values[0]; console.log("frozen allowed"); }
catch (error) { console.log("frozen", (error as Error).name); }
delete values[3];
console.log("frozen contents", values.length, values[0]);
`);
  },
);

test.each(["main.cts", "main.mts"])(
  "property deletion follows lexical strictness in %s",
  async (fileName) => {
    await matchesNode(
      `
const values = ["kept"];
function seal(value: any): void { Object.seal(value); }
seal(values);
try { delete values[0]; console.log("top allowed"); }
catch (error) { console.log("top", (error as Error).name); }
const checked: any = values;
try { delete checked[0]; console.log("checked allowed"); }
catch (error) { console.log("checked", (error as Error).name); }
function loose(): void { delete values[0]; }
function strict(): void { "use strict"; delete values[0]; }
class Drop { run(): void { delete values[0]; } }
try { loose(); console.log("function allowed"); }
catch (error) { console.log("function", (error as Error).name); }
try { strict(); console.log("strict allowed"); }
catch (error) { console.log("strict", (error as Error).name); }
try { new Drop().run(); console.log("class allowed"); }
catch (error) { console.log("class", (error as Error).name); }
console.log("contents", values.length, values[0]);
`,
      fileName,
    );
  },
);

test("native class bag descriptors preserve reentry, conversion order and identity", async () => {
  await matchesNode(`"use strict";
class Item { value = 1; }
for (const batch of [false, true]) {
  for (const throws of [false, true]) {
    const item = new Item();
    const view: any = item;
    const marker: any = JSON.parse("{}");
    const prototype: any = JSON.parse("{}");
    let order = "";
    Object.defineProperty(prototype, "enumerable", {
      get: function (): boolean { order += "enumerable;"; return true; },
    });
    Object.defineProperty(prototype, "value", {
      get: function (): number {
        order += "value;";
        item.value = 9;
        if (throws) throw marker;
        return 42;
      },
    });
    const descriptor: any = Object.create(prototype);
    try {
      const result = batch
        ? Object.defineProperties(view, { extra: descriptor })
        : Object.defineProperty(view, "extra", descriptor);
      console.log("success", batch, result === item, order, item.value, view.extra);
    } catch (error) {
      console.log("throw", batch, error === marker, order, item.value, Object.hasOwn(view, "extra"));
    }
    const invalid: any = JSON.parse("{}");
    Object.defineProperty(invalid, "get", { get: function (): number { order += "get;"; return 1; } });
    Object.defineProperty(invalid, "set", { get: function (): undefined { order += "set;"; return undefined; } });
    try {
      if (batch) Object.defineProperties(view, { first: { value: 7 }, invalid: invalid });
      else Object.defineProperty(view, "invalid", invalid);
    } catch (error) {
      console.log("invalid", batch, error instanceof TypeError, order, Object.hasOwn(view, "first"));
    }
  }
}
`);
});

test("native array value-position deletion remains explicitly refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-delete-value-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, "const values = [1]; console.log(delete values[0]);");
    const { coverage } = analyze(entry, {});
    expect(coverage.diagnostics.some((diagnostic) => diagnostic.code === "SC1090")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bare class declarations preserve concrete owners without exposing private storage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-class-declarations-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    writeFileSync(
      entry,
      `
class Local {
  value: number;
  #hidden: number;
  constructor() { this.value = 1; this.#hidden = 2; }
  read(): number { return this.value + this.#hidden; }
}
class Box<T> {
  value: T;
  declare erased: number;
  constructor(value: T) { this.value = value; }
}
const numberBox: unknown = new Box(1);
const stringBox: unknown = new Box("two");
console.log(new Local().read(), Object.keys(numberBox as object), Object.keys(stringBox as object));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const module = deserializeModule(readFileSync(output, "utf8"));
    const local = module.classes!.find((cls) => cls.jsName === "Local")!;
    expect(module.functions.some((fn) => fn.name.startsWith("%class.declare."))).toBe(false);
    expect(local).toBeDefined();
    expect(local.tracksOwnFields).toBeFalsy();
    expect(local.nativePropertyBagHelper).toBeUndefined();
    const family = module.classes!.find((cls) => cls.jsName === "Box" && !cls.genericOf)!;
    expect(family).toBeDefined();
    // The family can own compiler storage, but source fields belong to concrete layouts.
    expect(family.fields.filter((field) => field.visibility !== "internal")).toHaveLength(0);
    const boxes = module.classes!.filter((cls) => cls.genericOf === family.name);
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect(box.nativePropertyBagHelper).toBeDefined();
      expect(box.fields.some((field) => field.name === "erased")).toBe(true);
    }
    const declared = new Set<string>();
    for (const fn of module.functions)
      everyStmtList(fn.body, {
        stmt: () => true,
        expr: (expr) => {
          if (expr.kind === "intrinsic" && expr.name === "native.declareUndefined") {
            const type = expr.args[0]!.type;
            expect(type.kind).toBe("object");
            if (type.kind === "object") declared.add(type.className);
          }
          return true;
        },
      });
    expect([...declared].sort()).toEqual(boxes.map((box) => box.name).sort());
    const llvm = emitLlvmModule(module, { runtimeAbiMarker: false });
    expect(llvm).toContain("@scr_native_object_declare_undefined");
    expect(llvm).toContain("@scr_native_property_declared_undefined");
    expect(
      emitLlvmModule(deserializeModuleBytes(Buffer.from(serializeModule(module, true))), {
        runtimeAbiMarker: false,
      }),
    ).toBe(llvm);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
