/* The handle member tables, the builtins they name and the bundled
 * declarations agree. A member the declaration gives a handle class is a
 * table row whose builtin has the declared parameter and result types, or
 * one of the members a dedicated lowering compiles; a new declared member, a
 * row the declaration lacks and a stale dedicated name all fail. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { libFnSignatures } from "../../ir/builtin-signatures.js";
import { DYN_HANDLE_KINDS } from "../../ir/ir.js";
import {
  DGRAM_SOCKET_MEMBERS,
  handleMemberSignature,
  handleMemberTypeName,
  type HandleMemberTable,
} from "./handle-members.js";

const ambient = join(import.meta.dirname, "../../../ambient/node-fallback");

interface DeclaredMethod {
  /** `name: type` or `name?: type`, as written. */
  params: string[];
  result: string;
}

/** The method signatures of `export interface <name>` in a bundled
 * declaration file, by member name, one entry per overload. */
function declaredMethods(file: string, name: string): Map<string, DeclaredMethod[]> {
  const text = readFileSync(join(ambient, file), "utf8");
  const start = text.indexOf(`export interface ${name} {`);
  expect(start, `${file} declares interface ${name}`).toBeGreaterThanOrEqual(0);
  const body = text.slice(text.indexOf("\n", start) + 1, text.indexOf("\n  }\n", start));
  const methods = new Map<string, DeclaredMethod[]>();
  for (const line of body.split("\n")) {
    const match = /^ {4}(\w+)\((.*)\): (.+);$/.exec(line);
    // Every line of the interface is one method signature.
    expect(match, `${file}: ${line}`).not.toBeNull();
    const [, member, params, result] = match!;
    const overloads = methods.get(member!) ?? [];
    overloads.push({ params: params === "" ? [] : params!.split(", "), result: result! });
    methods.set(member!, overloads);
  }
  return methods;
}

/** What the table says a member's declaration is. */
function expectedDeclaration(table: HandleMemberTable, member: string): DeclaredMethod {
  const row = table[member]!;
  const { params, result } = handleMemberSignature(row);
  const required = params.length - (row.optional ?? 0);
  return {
    params: params.map((type, i) => `${i < required ? ":" : "?:"} ${handleMemberTypeName(type)}`),
    result: handleMemberTypeName(result),
  };
}

interface HandleClass {
  file: string;
  name: string;
  /** The handle kind of the class: the first argument of every member's builtin. */
  kind: string;
  table: HandleMemberTable;
  /** Members compiled by a dedicated lowering, which takes callbacks,
   * overloads or records a table row cannot describe. */
  dedicated: string[];
}

const HANDLE_CLASSES: HandleClass[] = [
  {
    file: "dgram.d.ts",
    name: "Socket",
    kind: "dgramSocket",
    table: DGRAM_SOCKET_MEMBERS,
    dedicated: ["address", "bind", "close", "connect", "on", "once", "ref", "send", "unref"],
  },
];

describe.each(HANDLE_CLASSES)("$file $name", ({ file, name, kind, table, dedicated }) => {
  const declared = declaredMethods(file, name);

  test("every declared member is a table row or a dedicated lowering, and nothing else is", () => {
    expect([...declared.keys()].sort()).toEqual([...Object.keys(table), ...dedicated].sort());
    expect(Object.keys(table).filter((member) => dedicated.includes(member))).toEqual([]);
  });

  test("each row's builtin takes the handle first and has the declared types", () => {
    expect(DYN_HANDLE_KINDS.has(kind)).toBe(true);
    for (const member of Object.keys(table)) {
      const row = table[member]!;
      expect(libFnSignatures()[row.fn].argTypes[0], member).toEqual({ kind });
      const overloads = declared.get(member)!;
      expect(overloads.length, `${member} is declared once`).toBe(1);
      const expected = expectedDeclaration(table, member);
      // The declaration names its parameters; the table types them.
      expect(
        overloads[0]!.params.map((param) => param.replace(/^\w+/, "")),
        member,
      ).toEqual(expected.params);
      expect(overloads[0]!.result, member).toBe(expected.result);
    }
  });

  test("a member with omittable parameters ends its builtin with the given flag", () => {
    for (const [member, row] of Object.entries(table)) {
      if (row.optional === undefined) continue;
      const args = libFnSignatures()[row.fn].argTypes;
      expect(args[args.length - 1], member).toEqual({ kind: "bool" });
      expect(row.optional, member).toBe(1);
    }
  });
});
