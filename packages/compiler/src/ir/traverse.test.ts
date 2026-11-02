import { createProgram } from "../frontend/ts7/program-adapter.js";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import * as ts from "../frontend/ts7/adapter.js";
import { BOOL, F64, VOID, type IrExpr, type IrModule, type IrStmt, type IrType } from "./ir.js";
import {
  everyModuleNode,
  everyTypeChild,
  everyExpr,
  everyExprChild,
  everyStmtChild,
  everyStmtList,
  mapExprChildren,
  mapStmtChildren,
  observeRecordLiteralRebuilds,
  transformExpr,
  transformStmtList,
} from "./traverse.js";

const loc = { file: "traverse.ts", start: 0, end: 1 };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const statement = (value: number): IrStmt => ({ kind: "exprStmt", expr: num(value), loc });

// Derive child slots from the declared IR, independently of the traversal
// tables. Exhaustive switches catch new variants; this also catches a new
// child field added to an existing variant. These structural samples need
// not be executable: a child's identity and position are the contract here.
const path = fileURLToPath(new URL("./ir.ts", import.meta.url));
const program = createProgram([path], { noLib: true, noResolve: true, types: [] });
const source = program.getSourceFile(path)!;
afterAll(() => program.dispose());
function childType(type: ts.TypeNode): boolean {
  if (ts.isTypeReferenceNode(type))
    return ["IrExpr", "IrStmt"].includes(ts.getTextOfNode(type.typeName));
  if (ts.isArrayTypeNode(type)) return childType(type.elementType);
  if (ts.isUnionTypeNode(type)) return type.types.nodes.some(childType);
  if (ts.isTypeLiteralNode(type))
    return type.members.nodes.some(
      (member) => ts.isPropertySignature(member) && member.type && childType(member.type),
    );
  return false;
}

for (const name of ["IrExpr", "IrStmt"]) {
  const alias = source.statements.nodes.find(
    (node): node is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(node) && node.name.text === name,
  )!;
  if (!ts.isUnionTypeNode(alias.type)) throw new Error("IR must be a discriminated union");
  for (const variant of alias.type.types.nodes) {
    if (!ts.isTypeLiteralNode(variant)) throw new Error("IR variants must be records");
    const members = variant.members.nodes.filter(ts.isPropertySignature);
    const tag = members.find((member) => ts.getTextOfNode(member.name) === "kind")!.type!;
    const kind = JSON.parse(ts.getTextOfNode(tag)) as string;
    test(`${name}.${kind}: every declared child is visited and rewritten, metadata is preserved`, () => {
      for (const presence of [true, false]) {
        const expected: (IrExpr | IrStmt)[] = [];
        function value(type: ts.TypeNode): unknown {
          if (ts.isTypeReferenceNode(type)) {
            const node =
              ts.getTextOfNode(type.typeName) === "IrExpr"
                ? num(expected.length)
                : statement(expected.length);
            expected.push(node);
            return node;
          }
          if (ts.isUnionTypeNode(type))
            return presence ? value(type.types.nodes.find(childType)!) : null;
          if (ts.isArrayTypeNode(type)) return [value(type.elementType), value(type.elementType)];
          if (ts.isTypeLiteralNode(type)) {
            const result: Record<string, unknown> = {
              metadata: "keep wrapper fields",
              drop: true,
              overflow: true,
            };
            for (const member of type.members.nodes) {
              if (ts.isPropertySignature(member) && member.type && childType(member.type))
                result[ts.getTextOfNode(member.name)] = value(member.type);
            }
            return result;
          }
          throw new Error("unexpected child slot");
        }
        const input: Record<string, unknown> = {
          kind,
          type: F64,
          loc,
          metadata: { kind: "throw", value: num(999) },
        };
        for (const member of members) {
          if (member.type && childType(member.type) && (presence || !member.postfixToken))
            input[ts.getTextOfNode(member.name)] = value(member.type);
        }
        const before = structuredClone(input);
        const seen: (IrExpr | IrStmt)[] = [];
        const visit = (node: IrExpr | IrStmt): boolean => {
          seen.push(node);
          return true;
        };
        const each = (
          node: unknown,
          e: (e: IrExpr) => boolean,
          s: (s: IrStmt) => boolean,
        ): boolean =>
          name === "IrExpr"
            ? everyExprChild(node as IrExpr, e, s)
            : everyStmtChild(node as IrStmt, e, s);
        expect(each(input, visit, visit)).toBe(true);
        expect(seen).toEqual(expected);
        expected.forEach((child, i) => expect(seen[i]).toBe(child));
        // Every possible stopping position must suppress later children.
        for (let stop = 0; stop < expected.length; stop++) {
          let count = 0;
          const stopAt = (): boolean => count++ !== stop;
          expect(each(input, stopAt, stopAt)).toBe(false);
          expect(count).toBe(stop + 1);
        }
        const replacements: (IrExpr | IrStmt)[] = [];
        const expr = (): IrExpr => {
          const out = num(100 + replacements.length);
          replacements.push(out);
          return out;
        };
        const stmt = (): IrStmt => {
          const out = statement(100 + replacements.length);
          replacements.push(out);
          return out;
        };
        const output =
          name === "IrExpr"
            ? mapExprChildren(input as IrExpr, expr, stmt)
            : mapStmtChildren(input as IrStmt, expr, stmt);
        seen.length = 0;
        each(output, visit, visit);
        expect(seen).toEqual(replacements);
        replacements.forEach((child, i) => expect(seen[i]).toBe(child));
        expect(input).toEqual(before);
        expect(output.loc).toBe(loc);
        expect((output as unknown as Record<string, unknown>)["metadata"]).toBe(input["metadata"]);
        for (const member of members) {
          const key = ts.getTextOfNode(member.name);
          if (member.postfixToken && !presence) expect(Object.hasOwn(output, key)).toBe(false);
        }
      }
    });
  }
}

test("recursive preorder reaches statements inside expressions and stops the complete walk", () => {
  const body: IrStmt[] = [
    {
      kind: "if",
      cond: { kind: "boolLit", value: true, type: BOOL, loc },
      then: [
        {
          kind: "exprStmt",
          expr: { kind: "seqExpr", stmts: [statement(1)], result: num(2), type: F64, loc },
          loc,
        },
      ],
      else_: [statement(3)],
      loc,
    },
    statement(4),
  ];
  const seen: string[] = [];
  expect(
    everyStmtList(body, {
      expr: (e) => {
        seen.push(e.kind);
        return e.kind !== "numLit";
      },
      stmt: (s) => {
        seen.push(s.kind);
        return true;
      },
    }),
  ).toBe(false);
  expect(seen).toEqual(["if", "boolLit", "exprStmt", "seqExpr", "exprStmt", "numLit"]);
  expect(
    everyExpr(num(0), {
      expr: () => false,
      stmt: () => {
        throw new Error("unexpected child");
      },
    }),
  ).toBe(false);
});

test("preorder transformations traverse replacement children exactly once", () => {
  const body = [statement(1)];
  const seen: string[] = [];
  const result = transformStmtList(body, {
    stmt: (s) => {
      seen.push(s.kind);
      return s.kind === "exprStmt" ? { kind: "return", value: s.expr, loc: s.loc } : s;
    },
    expr: (e) => {
      seen.push(e.kind);
      return e.kind === "numLit"
        ? { kind: "intrinsic", name: "console.log", args: [], type: VOID, loc: e.loc }
        : e;
    },
  });
  expect(seen).toEqual(["exprStmt", "numLit"]);
  expect(result).toEqual([
    {
      kind: "return",
      value: { kind: "intrinsic", name: "console.log", args: [], type: VOID, loc },
      loc,
    },
  ]);
  expect(body).toEqual([statement(1)]);
});

// Build the typed slots from the schema too: adding a field to a declaration
// must fail this audit until module traversal accounts for it.
test("module traversal covers every declared type slot", () => {
  const expected: IrType[] = [];
  const active = new Set<string>();
  function slots(node: ts.TypeNode): unknown {
    if (ts.isTypeReferenceNode(node)) {
      const name = ts.getTextOfNode(node.typeName);
      if (name === "IrType") {
        const value: IrType = { kind: "regex" };
        expected.push(value);
        return value;
      }
      if (name === "IrExpr") return { kind: "numLit", value: 0, loc, type: slotsType() };
      if (name === "IrStmt")
        return {
          kind: "exprStmt",
          loc,
          expr: { kind: "numLit", value: 0, loc, type: slotsType() },
        };
      if (name === "SrcLoc") return loc;
      if (active.has(name)) throw new Error(`unexpected recursive schema reference: ${name}`);
      const declaration = source.statements.nodes.find(
        (item) =>
          (ts.isInterfaceDeclaration(item) || ts.isTypeAliasDeclaration(item)) &&
          item.name.text === name,
      );
      if (!declaration) return undefined;
      active.add(name);
      const result = ts.isInterfaceDeclaration(declaration)
        ? fields(declaration.members.nodes)
        : ts.isTypeAliasDeclaration(declaration)
          ? slots(declaration.type)
          : undefined;
      active.delete(name);
      return result;
    }
    if (ts.isTypeLiteralNode(node)) return fields(node.members.nodes);
    if (ts.isArrayTypeNode(node)) return [slots(node.elementType)];
    if (ts.isParenthesizedTypeNode(node)) return slots(node.type);
    if (ts.isIntersectionTypeNode(node)) return slots(node.types.nodes[0]!);
    if (ts.isUnionTypeNode(node)) {
      // Metadata unions can choose any arm: the schema puts executable and
      // typed alternatives first, followed by null/unit alternatives.
      return slots(node.types.nodes[0]!);
    }
    return undefined;
  }
  function slotsType(): IrType {
    const value: IrType = { kind: "regex" };
    expected.push(value);
    return value;
  }
  function fields(members: readonly ts.TypeElement[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const member of members) {
      if (!ts.isPropertySignature(member) || !member.type) continue;
      const value = slots(member.type);
      if (value !== undefined) result[ts.getTextOfNode(member.name)] = value;
    }
    return result;
  }
  const declaration = source.statements.nodes.find(
    (item): item is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(item) && item.name.text === "IrModule",
  )!;
  const module = {
    ...fields(declaration.members.nodes),
    sourceFile: loc.file,
  } as unknown as IrModule;
  const seen: IrType[] = [];
  expect(
    everyModuleNode(module, {
      expr: () => true,
      stmt: () => true,
      type: (node) => {
        seen.push(node);
        return true;
      },
    }),
  ).toBe(true);
  expect(seen).toHaveLength(expected.length);
  for (const node of expected) expect(seen.filter((item) => item === node)).toHaveLength(1);
  for (let stop = 0; stop < expected.length; stop++) {
    let visits = 0;
    expect(
      everyModuleNode(module, {
        expr: () => true,
        stmt: () => true,
        type: () => visits++ !== stop,
      }),
    ).toBe(false);
    expect(visits).toBe(stop + 1);
  }
});

test("type traversal visits all structural children and leaves named shapes as references", () => {
  const alias = source.statements.nodes.find(
    (node): node is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(node) && node.name.text === "IrType",
  )!;
  if (!ts.isUnionTypeNode(alias.type)) throw new Error("IrType must be a union");
  for (const variant of alias.type.types.nodes) {
    if (!ts.isTypeLiteralNode(variant)) throw new Error("IrType variants must be records");
    const members = variant.members.nodes.filter(ts.isPropertySignature);
    const kind = JSON.parse(
      ts.getTextOfNode(members.find((member) => ts.getTextOfNode(member.name) === "kind")!.type!),
    ) as string;
    const node: Record<string, unknown> = { kind };
    const expected: IrType[] = [];
    for (const member of members) {
      if (!member.type) continue;
      const child =
        ts.isTypeReferenceNode(member.type) && ts.getTextOfNode(member.type.typeName) === "IrType";
      const array =
        ts.isArrayTypeNode(member.type) && ts.getTextOfNode(member.type.elementType) === "IrType";
      if (!child && !array) continue;
      const value: IrType = { kind: "fileHandle" };
      expected.push(value);
      node[ts.getTextOfNode(member.name)] = array ? [value] : value;
    }
    const seen: IrType[] = [];
    expect(
      everyTypeChild(node as IrType, (child) => {
        seen.push(child);
        return true;
      }),
    ).toBe(true);
    expect(seen).toHaveLength(expected.length);
    expected.forEach((child, i) => expect(seen[i]).toBe(child));
    for (let stop = 0; stop < expected.length; stop++) {
      let count = 0;
      expect(everyTypeChild(node as IrType, () => count++ !== stop)).toBe(false);
      expect(count).toBe(stop + 1);
    }
  }
});

// A rewrite pass walks a whole function and usually changes nothing in it.
// These tests pin the allocation contract that follows: an untouched subtree
// keeps its identity, so the pass allocates nothing for it and a side table
// keyed by node identity stays valid.
const varRef = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });
const binAdd = (left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "bin",
  op: "+",
  left,
  right,
  type: F64,
  loc,
});
const ret = (value: IrExpr): IrStmt => ({ kind: "return", value, loc });
const blockOf = (body: IrStmt[]): IrStmt => ({ kind: "block", body, loc });
const identity = {
  expr: (node: IrExpr): IrExpr => node,
  stmt: (node: IrStmt): IrStmt => node,
};

test("a transform that changes nothing returns the nodes and lists it was given", () => {
  const sum = binAdd(varRef("a"), binAdd(num(1), num(2)));
  const body = [blockOf([ret(sum)]), ret(num(3))];
  const transformed = transformStmtList(body, identity);
  expect(transformed).toBe(body);
  expect(transformed[0]).toBe(body[0]);
  expect((transformed[0] as { body: IrStmt[] }).body).toBe((body[0] as { body: IrStmt[] }).body);
  expect(((body[0] as { body: IrStmt[] }).body[0] as { value: IrExpr }).value).toBe(sum);
  expect(transformExpr(sum, identity)).toBe(sum);
});

test("a changed leaf rebuilds exactly the path to it", () => {
  const inner = binAdd(num(1), num(2));
  const sum = binAdd(varRef("a"), inner);
  const rewritten = transformExpr(sum, {
    expr: (node) => (node.kind === "varRef" ? num(9) : node),
    stmt: (node) => node,
  });
  expect(rewritten).not.toBe(sum);
  expect((rewritten as { left: IrExpr }).left).toEqual(num(9));
  // The untouched right subtree keeps its identity.
  expect((rewritten as { right: IrExpr }).right).toBe(inner);
});

test("the record-literal observer fires only when the literal is rebuilt", () => {
  const literal: IrExpr = {
    kind: "recordLit",
    fields: [{ name: "a", value: num(1) }],
    type: { kind: "record", shapeId: "s1" },
    loc,
  };
  const seen: [IrExpr, IrExpr][] = [];
  observeRecordLiteralRebuilds((from, to) => seen.push([from, to]));
  try {
    expect(mapExprChildren(literal, identity.expr, identity.stmt)).toBe(literal);
    expect(seen).toEqual([]);
    const rebuilt = mapExprChildren(
      literal,
      (node) => (node.kind === "numLit" ? num(2) : node),
      identity.stmt,
    );
    expect(rebuilt).not.toBe(literal);
    expect(seen).toEqual([[literal, rebuilt]]);
    expect((rebuilt as { fields: { value: IrExpr }[] }).fields[0]!.value).toEqual(num(2));
  } finally {
    observeRecordLiteralRebuilds(null);
  }
});

test("a switch rebuilds only its changed case and keeps the others", () => {
  const kept = { test: num(1), body: [ret(num(1))] };
  const changed = { test: num(2), body: [ret(num(2))] };
  const node: IrStmt = { kind: "switch", disc: varRef("d"), cases: [kept, changed], loc };
  const mapped = mapStmtChildren(
    node,
    (child) => (child.kind === "numLit" && child.value === 2 ? num(22) : child),
    identity.stmt,
  );
  expect(mapped).not.toBe(node);
  const cases = (mapped as { cases: { test: IrExpr; body: IrStmt[] }[] }).cases;
  expect(cases[0]).toBe(kept);
  expect(cases[1]).toEqual({ test: num(22), body: [ret(num(2))] });
});
