import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { ARRAY_PROTOTYPE_MEMBER_NAMES } from "../../ir/runtime-features.js";
import { BYTES_ELEM_NUM, CLOSURE_KIND, SCR_ARR_FROZEN, SCR_ARR_STATES } from "./common.js";
import { DYN_KIND, MESSAGE_KIND } from "./dyn.js";
import { mapKeyKindNum } from "./shapes.js";
import { BOOL, DYN, F64, STRING, type IrType } from "../../ir/ir.js";

// The backend writes the numbers of several runtime enums and flag sets
// into the IR it emits, and the IR layer names the methods a runtime
// prototype installs. Each check here reads the C declaration and fails
// when the copy disagrees, or when two names share a value.
const source = (file: string) =>
  readFileSync(new URL(`../../../../runtime/src/${file}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

/** Resolves the `#ifdef NAME` / `#else` / `#endif` blocks a header opens, so a
 * declaration a feature macro extends can be read in either configuration. */
function conditional(text: string, defines: readonly string[]): string {
  const kept: string[] = [];
  const open: boolean[] = [];
  for (const line of text.split("\n")) {
    const directive = /^\s*#\s*(ifdef|ifndef|else|endif)\b\s*(\w*)/.exec(line);
    if (directive !== null) {
      const [, kind, name] = directive;
      if (kind === "ifdef" || kind === "ifndef") {
        const named = defines.includes(name!);
        open.push(kind === "ifdef" ? named : !named);
      } else if (kind === "else") open[open.length - 1] = !open[open.length - 1];
      else open.pop();
      continue;
    }
    if (open.every((on) => on)) kept.push(line);
  }
  return kept.join("\n");
}

/** The members of `typedef enum ... { ... } <name>;` with their values. A
 * `defines` list reads the declaration as that feature configuration builds it;
 * without one the raw text is used. */
function cEnum(file: string, name: string, defines?: readonly string[]): Map<string, number> {
  const text = source(file);
  const match = new RegExp(`typedef enum(?: \\w+)? \\{([^}]*)\\} ${name};`).exec(
    defines === undefined ? text : conditional(text, defines),
  );
  expect(match, `${name} in ${file}`).not.toBeNull();
  const body = match![1]!;
  const members = new Map<string, number>();
  let next = 0;
  for (const entry of body
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)) {
    const [, member, value] = /^(\w+)(?:\s*=\s*(\d+))?$/.exec(entry)!;
    const v = value === undefined ? next : Number(value);
    members.set(member!, v);
    next = v + 1;
  }
  return members;
}

/** The `#define <prefix>NAME <n>u` flags of a header. */
function cFlags(file: string, prefix: string): Map<string, number> {
  const re = new RegExp(`^#define ${prefix}(\\w+) (\\d+)u\\b`, "gm");
  return new Map([...source(file).matchAll(re)].map(([, name, value]) => [name!, Number(value)]));
}

function expectDistinct(values: Map<string, number>, what: string): void {
  const owners = new Map<number, string>();
  for (const [name, value] of values) {
    expect(owners.get(value), `${what}: ${name} = ${value}`).toBeUndefined();
    owners.set(value, name);
  }
}

function expectSingleBits(values: Map<string, number>, what: string): void {
  for (const [name, value] of values) {
    expect(value > 0 && (value & (value - 1)) === 0, `${what}: ${name} = ${value}`).toBe(true);
  }
  expectDistinct(values, what);
}

test("DYN_KIND matches ScrDynKind", () => {
  const kinds = cEnum("scr_dyn.h", "ScrDynKind");
  expectDistinct(kinds, "ScrDynKind");
  for (const [name, value] of Object.entries(DYN_KIND)) {
    expect(kinds.get(`SCR_DYN_${name}`), name).toBe(value);
  }
});

test("MESSAGE_KIND matches ScrMessageKind", () => {
  const kinds = cEnum("scr_dyn.h", "ScrMessageKind");
  expectDistinct(kinds, "ScrMessageKind");
  for (const [name, value] of Object.entries(MESSAGE_KIND)) {
    expect(kinds.get(`SCR_MESSAGE_${name}`), name).toBe(value);
  }
});

test("BYTES_ELEM_NUM matches ScrBytesElem", () => {
  const elems = cEnum("scr_bytes.h", "ScrBytesElem", []);
  expectDistinct(elems, "ScrBytesElem");
  expect(Object.keys(BYTES_ELEM_NUM).length).toBe(elems.size);
  for (const [name, value] of Object.entries(BYTES_ELEM_NUM)) {
    expect(elems.get(`SCR_BYTES_${name.toUpperCase()}`), name).toBe(value);
  }
});

test("the SCR_JS_OBJECT_MODEL build appends the BigInt element kinds", () => {
  const plain = cEnum("scr_bytes.h", "ScrBytesElem", []);
  const bigint = cEnum("scr_bytes.h", "ScrBytesElem", ["SCR_JS_OBJECT_MODEL"]);
  expectDistinct(bigint, "ScrBytesElem");
  expect([...bigint.keys()].slice(0, plain.size)).toEqual([...plain.keys()]);
  for (const [name, value] of plain) expect(bigint.get(name)).toBe(value);
  expect(bigint.get("SCR_BYTES_I64")).toBe(plain.size);
  expect(bigint.get("SCR_BYTES_U64")).toBe(plain.size + 1);
});

test("CLOSURE_KIND matches the SCR_CLOSURE_KIND_* bits", () => {
  const flags = cFlags("scr_closure.h", "SCR_CLOSURE_KIND_");
  expect(flags.get("CALL_MASK")).toBe(CLOSURE_KIND.GENERATOR | CLOSURE_KIND.ASYNC);
  flags.delete("CALL_MASK");
  expect(flags.get("MASK")).toBe(CLOSURE_KIND.RECEIVER_FREE - 1);
  flags.delete("MASK");
  expectSingleBits(flags, "SCR_CLOSURE_KIND");
  expect(Object.fromEntries(flags)).toEqual(CLOSURE_KIND);
});

test("ARRAY_PROTOTYPE_MEMBER_NAMES matches the Array.prototype method table", () => {
  // The runtime installs these methods on Array.prototype, and the IR and
  // backend read the set to decide which reads link the dyn-invoke unit.
  const body = /dyn_array_prototype_methods\[\] = \{([\s\S]*?)\};/.exec(
    source("scr_dyn_invoke.c"),
  )?.[1];
  expect(body, "dyn_array_prototype_methods in scr_dyn_invoke.c").toBeDefined();
  const names = [...body!.matchAll(/\{"(\w+)", \d+\}/g)].map(([, name]) => name!);
  expect(new Set(names)).toEqual(ARRAY_PROTOTYPE_MEMBER_NAMES);
});

test("the %ScrArr spare flags the backend tests match scr_array.h", () => {
  const flags = cFlags("scr_array.h", "SCR_ARR_");
  const spare = new Map(
    ["INLINE_SLOTS", "HEAD_ROOM", "UNSHIFTED", "HAS_EXT", "STATES", "FROZEN"].map((name) => [
      name,
      flags.get(name)!,
    ]),
  );
  expectSingleBits(spare, "%ScrArr spare");
  expect(spare.get("STATES")).toBe(SCR_ARR_STATES);
  expect(spare.get("FROZEN")).toBe(SCR_ARR_FROZEN);
});

test("mapKeyKindNum matches ScrMapKeyKind", () => {
  const kinds = cEnum("scr_map.h", "ScrMapKeyKind");
  expectDistinct(kinds, "ScrMapKeyKind");
  const record: IrType = { kind: "record", shapeId: "r" };
  const cases: [IrType, string][] = [
    [F64, "F64"],
    [STRING, "STR"],
    [record, "REF"],
    [DYN, "DYN"],
    [{ kind: "bigint" }, "BIGINT"],
    [BOOL, "BOOL"],
    [{ kind: "nullT" }, "NULL"],
    [{ kind: "undefinedT" }, "UNDEFINED"],
    [{ kind: "promise", inner: F64 }, "PROMISE"],
  ];
  for (const [type, name] of cases) {
    expect(kinds.get(`SCR_MAP_KEY_${name}`), name).toBe(mapKeyKindNum(type));
  }
  const union: IrType = { kind: "union", unionId: "u" };
  expect(mapKeyKindNum(union, [record, record])).toBe(kinds.get("SCR_MAP_KEY_UNION_REF"));
  expect(mapKeyKindNum(union, [STRING, F64])).toBe(kinds.get("SCR_MAP_KEY_UNION_VALUE"));
});
