import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { BYTES_ELEM_NUM, CLOSURE_KIND, SCR_ARR_FROZEN, SCR_ARR_STATES } from "./common.js";
import { DYN_KIND, MESSAGE_KIND } from "./dyn.js";

// The backend writes the numbers of several runtime enums and flag sets
// into the IR it emits. Each check here reads the C declaration and fails
// when the backend's copy disagrees, or when two names share a value.
const source = (file: string) =>
  readFileSync(new URL(`../../../../runtime/src/${file}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

/** The members of `typedef enum ... { ... } <name>;` with their values. */
function cEnum(file: string, name: string): Map<string, number> {
  const match = new RegExp(`typedef enum(?: \\w+)? \\{([^}]*)\\} ${name};`).exec(source(file));
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
  const elems = cEnum("scr_bytes.h", "ScrBytesElem");
  expectDistinct(elems, "ScrBytesElem");
  expect(Object.keys(BYTES_ELEM_NUM).length).toBe(elems.size);
  for (const [name, value] of Object.entries(BYTES_ELEM_NUM)) {
    expect(elems.get(`SCR_BYTES_${name.toUpperCase()}`), name).toBe(value);
  }
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
