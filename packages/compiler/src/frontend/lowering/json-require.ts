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
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { PoisonError } from "./lowerer.js";
import type { FileParts } from "./lower-modules.js";
import { isCjsJsFile, locOf, requireSpecOf, resolveImport } from "../program.js";
import { createRequireCalleeFileOf } from "./builtins/module-bindings.js";
import { invalidJsonModuleDiag } from "../../diagnostics/diagnostic.js";
import { BOOL, type IrExpr, type IrGlobal, type IrType } from "../../ir/ir.js";

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
  if (call === undefined || !ts.isCallExpression(call)) return null;
  const spec = requireSpecOf(call);
  if (spec === null || !ts.isIdentifier(call.expression)) return null;
  const sf = ts.getSourceFileOfNode(call);
  if (!isCjsJsFile(sf, lowerer.program)) return null;
  if (createRequireCalleeFileOf(lowerer, call.expression) !== null) return null;
  const target = resolveImport(lowerer.program, sf, spec, "require");
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
    if (!sf.text.includes(".json")) continue;
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
          const mapped = lowerer.mapTypeOf(tsType);
          if (!mapped || !lowerer.comptimeBakeable(mapped)) lowerer.badType(call, tsType);
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
        const value = lowerer.comptimeValueToIr(mod.parsed, mod.type, "$", call);
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
