import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { ARRAY_PROTOTYPE_MEMBER_NAMES } from "../../ir/runtime-features.js";
import {
  BYTES_ELEM_NUM,
  CLOSURE_KIND,
  DYN_INDEX_SET,
  SCR_ARR_FROZEN,
  SCR_ARR_STATES,
} from "./common.js";
import { DYN_KIND, MESSAGE_KIND } from "./dyn.js";
import { mapKeyKindNum } from "./shapes.js";
import {
  BOOL,
  DYN,
  DYN_HANDLE_KINDS,
  F64,
  ISLAND_ADOPTED_KINDS,
  STRING,
  type IrType,
} from "../../ir/ir.js";

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

test("DYN_INDEX_SET matches ScrDynIndexSet", () => {
  const answers = cEnum("scr_dyn.h", "ScrDynIndexSet");
  expectDistinct(answers, "ScrDynIndexSet");
  for (const [name, value] of Object.entries(DYN_INDEX_SET)) {
    expect(answers.get(`SCR_DYN_INDEX_${name}`), name).toBe(value);
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

test("ISLAND_ADOPTED_KINDS names conversions the runtime defines", () => {
  // A kind whose island-made instances a native slot holds converts through
  // its unit's own functions in a program with islands (dyn.ts
  // islandConversion). The unit is named after the kind's handle.
  for (const [kind, adoption] of ISLAND_ADOPTED_KINDS) {
    expect(DYN_HANDLE_KINDS.has(kind), kind).toBe(true);
    if (adoption.at !== "conversion") continue;
    const unit = source(`scr_node_island_${kind}.c`);
    const defined = (signature: RegExp, name: string) =>
      expect(signature.test(unit), `${name} in scr_node_island_${kind}.c`).toBe(true);
    defined(
      new RegExp(
        `^\\w+ \\*${adoption.unbox}\\(const ScrDyn \\*\\w+, const ScrDynPath \\*\\w+, const char \\*\\w+\\) \\{`,
        "m",
      ),
      adoption.unbox,
    );
    defined(new RegExp(`^ScrDyn \\*${adoption.box}\\(\\w+ \\*\\w+\\) \\{`, "m"), adoption.box);
    defined(new RegExp(`^bool ${adoption.is}\\(const ScrDyn \\*\\w+\\) \\{`, "m"), adoption.is);
  }
});

test("every entry point that takes a child handle hands an island's to the island", () => {
  // A ChildProcess slot can hold a child a Node island made
  // (scr_node_island_child.c). It has no native state, so an entry point that
  // read its fields would answer for a child that does not exist: each one
  // that takes a child, one of its streams or its writer starts with the
  // island guard. Reference counting is the same for both.
  const counted =
    /^scr_child(?:_stream|_writer)?_(?:retain|release)_v$|^scr_child(?:_stream|_writer)?_retain$/;
  const made = /^scr_child(?:_stream|_writer)?_island_new$/;
  for (const file of ["scr_child.c", "scr_child_lifecycle.c"]) {
    const text = source(file);
    // scr_child.c's Windows arm has no islands; the POSIX arm and the code
    // both arms share follow it.
    const posix =
      file === "scr_child.c" ? text.slice(text.search(/#else\s*\n\s*#include <errno\.h>/)) : text;
    expect(posix.length, file).toBeGreaterThan(1000);
    const entry =
      /^(?!static)[\w ]+[ *](scr_child\w*)\(Scr(?:Child|ChildStream|ChildWriter) \*\w+[^)]*\) \{/gm;
    const unguarded: string[] = [];
    let seen = 0;
    for (const match of posix.matchAll(entry)) {
      const name = match[1]!;
      if (counted.test(name) || made.test(name)) continue;
      seen++;
      const start = match.index! + match[0].length;
      const body = posix.slice(start, posix.indexOf("\n}", start) + 1);
      const oneLine = posix.slice(start, posix.indexOf("\n", start));
      if (!(oneLine.trimEnd().endsWith("}") ? oneLine : body).includes("SCR_IF_ISLAND("))
        unguarded.push(name);
    }
    expect(seen, file).toBeGreaterThan(file === "scr_child.c" ? 35 : 5);
    expect(unguarded, file).toEqual([]);
  }
});
