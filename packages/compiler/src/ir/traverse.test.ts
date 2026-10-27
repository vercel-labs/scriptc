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
