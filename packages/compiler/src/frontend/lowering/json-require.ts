/* CommonJS require() of JSON modules. Node parses the document at the
 * first require and caches the resulting object: every later require, from
 * any module, answers that same object, so a mutation through one requirer
 * is visible to all of them. The document is data known at build time, so
 * the object bakes from the parsed text (comptimeValueToIr, as JSON import
 * declarations do) into one global per document. The parse has no
 * observable effect, so each requiring module creates the object in its
 * %init prelude unless an earlier module already did, and every require
 * call of the document reads the shared global. A require binding of a
 * JSON module is ordinary storage holding that object — destructuring
 * copies its properties at the require, exactly like Node. ES-module JSON
 * imports keep their own record (Node's ESM loader caches separately). */
import { keyedHelperName } from "./stable-names.js";
import { isCjsRequireCallee } from "./require-callee-lowering.js";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { PoisonError } from "./lowerer.js";
import type { FileParts } from "./lower-modules.js";
import { isCjsJsFile, locOf, requireSpecOf } from "../program.js";
import { createRequireCalleeFileOf } from "./builtins/module-bindings.js";
import { invalidJsonModuleDiag } from "../../diagnostics/diagnostic.js";
import {
  BOOL,
  DYN,
  F64,
  NULL_T,
  STRING,
  type IrExpr,
  type IrGlobal,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";

/** A parsed JSON document as one checked-dynamic value. Node's
 * `Module#require` is typed `any`, so a require through it has no structural
 * type to bake into; the document then bakes as the dynamic value it is, and
 * its binding keeps that form, as every other untyped JavaScript value does. */
function jsonValueToDyn(value: unknown, loc: SrcLoc): IrExpr {
  const scalar = (literal: IrExpr): IrExpr => ({ kind: "dynFrom", value: literal, type: DYN, loc });
  if (value === null) return scalar({ kind: "unitLit", unit: "null", type: NULL_T, loc });
  if (typeof value === "string") return scalar({ kind: "strLit", value, type: STRING, loc });
  if (typeof value === "number") return scalar({ kind: "numLit", value, type: F64, loc });
  if (typeof value === "boolean") return scalar({ kind: "boolLit", value, type: BOOL, loc });
  if (Array.isArray(value))
    return {
      kind: "dynArrLit",
      elems: value.map((entry) => jsonValueToDyn(entry, loc)),
      type: DYN,
      loc,
    };
  const fields = Object.entries(value as Record<string, unknown>).map(([key, entry]) => ({
    key: { kind: "strLit" as const, value: key, type: STRING, loc },
    value: jsonValueToDyn(entry, loc),
  }));
  return { kind: "dynObjLit", fields, type: DYN, loc };
}

/** One required JSON document: its shared global, the run-once flag, and
 * the parsed value with the type it bakes to. */
export interface JsonRequireModule {
  global: IrGlobal;
  loadedId: string;
  parsed: unknown;
  type: IrType;
}

/** The JSON document a CommonJS `require("…")` call loads, or null. */
export function jsonRequireTarget(
  lowerer: Lowerer,
  call: ts.Expression | undefined,
): ts.SourceFile | null {
  if (call === undefined) return null;
  // A parenthesized initializer is the same require call.
  let value = call;
  while (ts.isParenthesizedExpression(value)) value = value.expression;
  if (!ts.isCallExpression(value)) return null;
  const callNode = value;
  if (!isCjsRequireCallee(lowerer, callNode.expression)) return null;
  const spec = requireSpecOf(callNode);
  if (spec === null) return null;
  const sf = ts.getSourceFileOfNode(callNode);
  if (!isCjsJsFile(sf, lowerer.program)) return null;
  if (
    ts.isIdentifier(callNode.expression) &&
    createRequireCalleeFileOf(lowerer, callNode.expression) !== null
  )
    return null;
  const target = lowerer.facts.importedModule(sf, spec, "require");
  return target !== null && target.fileName.endsWith(".json") ? target : null;
}

/** A declaration whose initializer is a require() of a JSON document. */
export function isJsonRequireDecl(lowerer: Lowerer, decl: ts.VariableDeclaration): boolean {
  return jsonRequireTarget(lowerer, decl.initializer) !== null;
}

/** Registers the shared global of every JSON document a CommonJS module of
 * the program requires, and the guarded creation in each requiring
 * module's %init prelude. */
export function collectJsonRequires(lowerer: Lowerer, parts: FileParts[]): void {
  for (const fp of parts) {
    const sf = fp.sf;
    if (sf.isDeclarationFile || !isCjsJsFile(sf, lowerer.program)) continue;
    if (!ts.sourceTextIncludes(sf, ".json")) continue;
    const calls: ts.CallExpression[] = [];
    ts.walkPreorder(sf, (node) => {
      if (ts.isCallExpression(node) && requireSpecOf(node) !== null) calls.push(node);
      return undefined;
    });
    const created = new Set<JsonRequireModule>();
    for (const call of calls) {
      const jsonSf = jsonRequireTarget(lowerer, call);
      if (jsonSf === null) continue;
      try {
        let mod = lowerer.jsonRequireModules.get(jsonSf.fileName);
        if (mod === undefined) {
          const tsType = lowerer.typeOf(call);
          let mapped = lowerer.mapTypeOf(tsType);
          // `module.require` is typed `any` (Node's Module#require has no
          // generic); the bare `require` spelling inherits the document's
          // structural type from TypeScript's require-call analysis. With no
          // structural type, the document bakes as its dynamic value.
          if (!mapped || !lowerer.comptimeBakeable(mapped)) {
            if (mapped === null || mapped.kind === "dyn") {
              mapped = DYN;
            } else {
              lowerer.badType(call, tsType);
            }
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(jsonSf.text);
          } catch (e) {
            lowerer.pushDiag(
              invalidJsonModuleDiag(
                jsonSf.fileName,
                e instanceof Error ? e.message : String(e),
                locOf(call),
              ),
            );
            throw new PoisonError();
          }
          const id = keyedHelperName(lowerer, "%g.jsonRequire", jsonSf.fileName);
          const global: IrGlobal = { id, name: "%json", type: mapped, mutable: true };
          const loadedId = `${id}%loaded`;
          lowerer.globalsList.push(global, {
            id: loadedId,
            name: "%loaded",
            type: BOOL,
            mutable: true,
          });
          mod = { global, loadedId, parsed, type: mapped };
          lowerer.jsonRequireModules.set(jsonSf.fileName, mod);
        }
        lowerer.jsonRequireCalls.set(call, mod);
        if (created.has(mod)) continue;
        created.add(mod);
        const loc = locOf(call);
        const value =
          mod.type.kind === "dyn"
            ? jsonValueToDyn(mod.parsed, loc)
            : lowerer.comptimeValueToIr(mod.parsed, mod.type, "$", call);
        const actions = lowerer.jsonInitActions.get(sf) ?? [];
        lowerer.jsonInitActions.set(sf, actions);
        actions.push({
          kind: "if",
          cond: {
            kind: "unary",
            op: "!",
            operand: { kind: "varRef", localId: mod.loadedId, type: BOOL, loc },
            type: BOOL,
            loc,
          },
          then: [
            {
              kind: "assign",
              localId: mod.loadedId,
              value: { kind: "boolLit", value: true, type: BOOL, loc },
              loc,
            },
            { kind: "assign", localId: mod.global.id, value, loc },
          ],
          else_: null,
          loc,
        });
      } catch (e) {
        if (!(e instanceof PoisonError)) throw e;
        // diagnostic already recorded
      }
    }
  }
}

/** A require() call of a JSON document: the shared object. */
export function lowerJsonRequireCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  const mod = lowerer.jsonRequireCalls.get(call);
  if (mod === undefined) return null;
  return { kind: "varRef", localId: mod.global.id, type: mod.global.type, loc: locOf(call) };
}
