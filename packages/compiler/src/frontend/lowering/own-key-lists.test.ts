import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../../index.js";
import type { IrFunction, IrStmt } from "../../ir/ir.js";
import { mentionsAny } from "./own-key-lists.js";

/** The three calls that answer a key list. */
const LISTS = ["Object.keys", "Object.getOwnPropertyNames", "Reflect.ownKeys"] as const;

/** Uses of the list that are answered from numbers: no array for a record
 * that reflects statically. */
const NUMBERS: Record<string, string> = {
  counted: `const keys = LIST(value); return keys.length;`,
  compared: `const keys = LIST(value); return keys[0] === "id" && keys[1] !== "author" ? 1 : 0;`,
  walked: `const keys = LIST(value);
    let at = 0;
    for (let i = 0; i < keys.length; i++) { if (keys[i] === "text") at += i; }
    if ("note" === keys[at]) at++;
    return at;`,
  nested: `if (other === "") return 0;
    { const keys = LIST(value); if (keys.length > 3) return 1; }
    return 2;`,
};

/** Uses that leave those forms: the array is built as before, and nothing
 * of this module remains. */
const ARRAY: Record<string, string> = {
  passed: `const keys = LIST(value); return take(keys) + keys.length;`,
  returned: `const keys = LIST(value); return keys;`,
  spread: `const keys = LIST(value); return [...keys].length + keys.length;`,
  captured: `const keys = LIST(value); const count = (): number => keys.length; return count();`,
  indexed: `const keys = LIST(value); const key = keys[index]; return String(key).length + keys.length;`,
  unnamed: `const keys = LIST(value); return keys[0] === other ? keys.length : 0;`,
  iterated: `const keys = LIST(value); let n = keys.length; for (const key of keys) n += String(key).length; return n;`,
  resized: `const keys = LIST(value); keys.length = 1; return keys.length;`,
  written: `const keys = LIST(value); keys[0] = "other"; return keys.length;`,
  fielded: `const keys = LIST(value);
    class Holder { count = keys.length; first = keys[0] === "id"; }
    const holder = new Holder();
    return holder.first ? holder.count : 0;`,
  rebound: `let keys = LIST(value); const count = keys.length; keys = []; return count + keys.length;`,
  followed: `const keys = LIST(value); const twice = (n: number): number => n * 2; return twice(keys.length);`,
};

function program(list: string): string {
  const fn = (name: string, body: string): string =>
    `function ${name}(value: R4, other: string, index: number): unknown {\n    ${body}\n}`;
  const names = [...Object.keys(NUMBERS), ...Object.keys(ARRAY)];
  return `
type R4 = { id: number; author: string; text: string; note?: string };
type Key = string | symbol;
function take(list: readonly Key[]): number { return list.length; }
${Object.entries({ ...NUMBERS, ...ARRAY })
  .map(([name, body]) => fn(name, body))
  .join("\n")}
const exact: R4 = { id: 1, author: "a", text: "t" };
console.log(${names.map((name) => `String(${name}(exact, "id", 1))`).join(", ")});
`.replaceAll("LIST", list);
}

/** The function `name` of a compiled program. */
function functionNamed(functions: readonly IrFunction[], name: string): IrFunction {
  const found = functions.filter((fn) => fn.name === name || fn.name.endsWith(`.${name}`));
  expect(
    found.map((fn) => fn.name),
    `the function ${name}`,
  ).toHaveLength(1);
  return found[0]!;
}

/** Every statement under `body` that tests a record once for this module. */
function versions(body: readonly IrStmt[]): (IrStmt & { kind: "if" })[] {
  const found: (IrStmt & { kind: "if" })[] = [];
  const walk = (stmts: readonly IrStmt[]): void => {
    for (const stmt of stmts) {
      if (stmt.kind === "if") {
        if (stmt.cond.kind === "call" && stmt.cond.callee.startsWith("%obj.reflectsStatic"))
          found.push(stmt);
        walk(stmt.then);
        if (stmt.else_) walk(stmt.else_);
      } else if (stmt.kind === "block") walk(stmt.body);
    }
  };
  walk(body);
  return found;
}

describe("own-key lists of a typed record", () => {
  let dir: string;
  const modules = new Map<string, readonly IrFunction[]>();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "scriptc-own-key-lists-"));
    for (const list of LISTS) {
      const entry = join(dir, `${list}.ts`);
      const outPath = join(dir, `${list}.ir.json`);
      await writeFile(entry, program(list));
      const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const mod = deserializeModule(await readFile(outPath, "utf8"));
      expect(validateModule(mod)).toEqual([]);
      modules.set(list, mod.functions);
    }
  }, 240_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe.each(LISTS)("%s", (list) => {
    test.each(Object.keys(NUMBERS))(
      "%s: numbers, and the array only for another record",
      (name) => {
        const fn = functionNamed(modules.get(list)!, name);
        const tested = versions(fn.body);
        expect(tested).toHaveLength(1);
        const cheap = JSON.stringify(tested[0]!.then);
        const before = JSON.stringify(tested[0]!.else_);
        // The cheap statements read the count and the positions and name no
        // local of the list; the other statements are the array's.
        expect(cheap).toContain("%keyCount");
        expect(cheap).not.toContain('"keys.');
        expect(before).toContain('"keys.');
        expect(before).not.toContain("%keyCount");
        // The list's local was declared twice and dropped once.
        expect(fn.locals.filter((local) => local.name === "keys")).toHaveLength(1);
      },
    );

    test.each(Object.keys(ARRAY))("%s: the array, as before", (name) => {
      const fn = functionNamed(modules.get(list)!, name);
      const body = JSON.stringify(fn.body);
      expect(versions(fn.body)).toHaveLength(0);
      expect(body).not.toContain("%keyCount");
      expect(body).not.toContain("%keyAt");
      expect(body).not.toContain("%obj.reflectsStatic");
      expect(fn.locals.filter((local) => local.name === "keys")).toHaveLength(1);
    });
  });
});

test("the questions asked in place are answered under the same test", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-own-key-questions-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
type R4 = { id: number; author: string; text: string; note?: string };
type Open = { [key: string]: number };
function plain(value: R4): boolean { return Object.getPrototypeOf(value) === Object.prototype; }
function other(value: R4): boolean { return Object.prototype !== Object.getPrototypeOf(value); }
function counted(value: R4): number { return Object.keys(value).length + Reflect.ownKeys(value).length; }
function open(value: Open): number { return Object.keys(value).length; }
function openPlain(value: Open): boolean { return Object.getPrototypeOf(value) === Object.prototype; }
const exact: R4 = { id: 1, author: "a", text: "t" };
console.log(plain(exact), other(exact), counted(exact), open({ a: 1 }), openPlain({ a: 1 }));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const body = (name: string): string => JSON.stringify(functionNamed(mod.functions, name).body);
    expect(body("plain")).toContain("%obj.reflectsStatic");
    expect(body("other")).toContain("%obj.reflectsStatic");
    expect(body("counted")).toContain("%obj.reflectsStatic");
    expect(body("counted")).toContain("%obj.keyCount");
    // A type with an index signature is not described by its declared fields.
    expect(body("open")).not.toContain("%obj.keyCount");
    expect(body("open")).not.toContain("%obj.reflectsStatic");
    expect(body("openPlain")).not.toContain("%obj.reflectsStatic");
    // The fact is one library call per record type, which says whether a
    // record of the type can be a linked copy: nothing is narrowed into R4.
    const fact = mod.functions.filter((fn) => fn.name.startsWith("%obj.reflectsStatic"));
    expect(fact).toHaveLength(1);
    expect(JSON.stringify(fact[0]!.body)).toContain(
      '"fn":"record.reflectsStatic","args":[{"kind":"varRef","localId":"r.0"',
    );
    expect(JSON.stringify(fact[0]!.body)).toContain('"kind":"boolLit","value":false');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);

describe("mentionsAny", () => {
  const ids = new Set(["keys.0"]);

  test("finds a local in any field of the statements", () => {
    expect(
      mentionsAny([{ kind: "exprStmt", expr: { kind: "varRef", localId: "keys.0" } }], ids),
    ).toBe(true);
    expect(mentionsAny([{ kind: "later", captures: [{ from: ["keys.0"] }] }], ids)).toBe(true);
    expect(mentionsAny({ kind: "assign", localId: "keys.0", value: null }, ids)).toBe(true);
  });

  test("other locals, source positions and types name none", () => {
    expect(mentionsAny([{ kind: "varRef", localId: "keys.1" }], ids)).toBe(false);
    expect(mentionsAny([{ kind: "numLit", loc: { file: "keys.0" }, type: "keys.0" }], ids)).toBe(
      false,
    );
    expect(mentionsAny([null, 1, true, undefined, "keys"], ids)).toBe(false);
  });
});
