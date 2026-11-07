import { describe, expect, test } from "vitest";
import {
  BUILTIN_CALLEE_READS,
  BUILTIN_CONSTRUCT_READS,
  BUILTIN_INSTANCE_OWN_MEMBERS,
  BUILTIN_MEMBER_READS,
  BUILTIN_OBJECT_MEMBERS,
} from "./builtin-object-members.generated.js";
import { CONSTRUCT_NAMES, SERVED_ADDERS } from "./builtin-member-readers.js";
import { builtinMemberKind, builtinOwnMemberKind } from "./builtin-member-writes.js";

/* The measured reader tables are held to the census and to the compiler:
 * builtin-member-writes.test.ts checks that the file is what the pinned Node
 * release answers, and these check that the compiler and the tables name
 * the same things. */

/** The names no built-in defines that operations still ask an object for. */
const PROBES = /^(then|toJSON|@@\w+)$/;

function parse(text: string): { keys: string[]; others: string[] } {
  const bar = text.indexOf(" | ");
  return {
    keys: (bar < 0 ? text : text.slice(0, bar)).split(" ").filter((key) => key !== ""),
    others: bar < 0 ? [] : text.slice(bar + 3).split(", "),
  };
}

function expectMembers(text: string, where: string): void {
  const { keys, others } = parse(text);
  const everyName = new Set<string>();
  for (const row of Object.values(BUILTIN_OBJECT_MEMBERS))
    for (const item of row.split(" ")) everyName.add(item.replace(/^.-?=?/, ""));
  for (const key of keys)
    expect(everyName.has(key) || PROBES.test(key), `${where}: ${key}`).toBe(true);
  for (const other of others) {
    const space = other.indexOf(" ");
    const owner = other.slice(0, space);
    const key = other.slice(space + 1);
    expect(BUILTIN_OBJECT_MEMBERS[owner], `${where}: ${owner}`).toBeDefined();
    expect(
      builtinOwnMemberKind(owner, key) !== null || PROBES.test(key),
      `${where}: ${other}`,
    ).toBe(true);
  }
}

describe("built-in member readers", () => {
  test("the compiler collects exactly the constructs that were measured", () => {
    expect(Object.keys(CONSTRUCT_NAMES).sort()).toEqual(
      Object.keys(BUILTIN_CONSTRUCT_READS).sort(),
    );
  });

  test("every construct row names classes and members of the census", () => {
    for (const [construct, rows] of Object.entries(BUILTIN_CONSTRUCT_READS)) {
      for (const [text, classes] of Object.entries(rows)) {
        expectMembers(text, construct);
        for (const cls of classes.split(", "))
          expect(
            BUILTIN_OBJECT_MEMBERS[cls] !== undefined ||
              ["string", "number", "boolean", "symbol", "bigint"].includes(cls),
            `${construct}: ${cls}`,
          ).toBe(true);
      }
    }
  });

  test("every member row is a prototype's own member", () => {
    for (const [member, text] of Object.entries(BUILTIN_MEMBER_READS)) {
      const space = member.indexOf(" ");
      const owner = member.slice(0, space);
      expect(owner.endsWith(".prototype"), member).toBe(true);
      expect(builtinOwnMemberKind(owner, member.slice(space + 1)), member).not.toBeNull();
      expectMembers(text, member);
    }
  });

  test("every callee is a built-in function a program can spell", () => {
    for (const [text, callees] of Object.entries(BUILTIN_CALLEE_READS)) {
      for (const callee of callees.split(", ")) {
        const name = callee.startsWith("new:") ? callee.slice(4) : callee;
        const dot = name.lastIndexOf(".");
        if (dot < 0 || BUILTIN_OBJECT_MEMBERS[name] !== undefined)
          expect(BUILTIN_OBJECT_MEMBERS[name], callee).toBeDefined();
        else
          expect(builtinOwnMemberKind(name.slice(0, dot), name.slice(dot + 1)), callee).toBe("f");
        expectMembers(text, callee);
      }
    }
  });

  test("an instance's own members are members of its prototype chain", () => {
    for (const [prototype, names] of Object.entries(BUILTIN_INSTANCE_OWN_MEMBERS))
      for (const name of names.split(" "))
        expect(builtinMemberKind(prototype, name), `${prototype} ${name}`).not.toBeNull();
    expect(BUILTIN_INSTANCE_OWN_MEMBERS["Array.prototype"]).toBe("length");
  });

  test("the adders the runtime's collection constructors serve were measured", () => {
    for (const [callee, adder] of Object.entries(SERVED_ADDERS)) {
      const row = Object.entries(BUILTIN_CALLEE_READS).find(([, callees]) =>
        callees.split(", ").includes(callee),
      );
      expect(row, callee).toBeDefined();
      expect(parse(row![0]).others, callee).toContain(adder);
    }
  });

  test("the protocol readers the refusal rests on were measured", () => {
    const reads = (construct: string, cls: string): string[] => {
      for (const [text, classes] of Object.entries(BUILTIN_CONSTRUCT_READS[construct]!))
        if (classes.split(", ").includes(cls)) return parse(text).keys;
      return [];
    };
    expect(reads("string", "Array.prototype")).toEqual(["@@toPrimitive", "join", "toString"]);
    expect(reads("concat", "Object.prototype")).toContain("valueOf");
    expect(reads("number", "Date.prototype")).toEqual(["@@toPrimitive", "valueOf"]);
    expect(reads("iterate", "Array.prototype")).toEqual(["@@iterator"]);
    expect(reads("iterate", "string")).toEqual(["@@iterator"]);
    expect(reads("resolve", "Object.prototype")).toEqual(["then"]);
    expect(reads("await", "Promise.prototype")).toEqual(["constructor"]);
    expect(reads("json", "Date.prototype")).toContain("toISOString");
    // A primitive is never asked to convert itself.
    expect(reads("string", "number")).toEqual([]);
    expect(parse(BUILTIN_MEMBER_READS["Promise.prototype catch"]!).keys).toContain("then");
    expect(parse(BUILTIN_MEMBER_READS["Array.prototype toString"]!).keys).toEqual(["join"]);
  });
});
