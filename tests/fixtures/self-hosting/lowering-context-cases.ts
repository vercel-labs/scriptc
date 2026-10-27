import { writeFileSync } from "node:fs";
import * as ts from "../../../packages/compiler/src/frontend/ts7/adapter.js";
import { bindingSource } from "../../../packages/compiler/src/frontend/binding-source.js";
import { loadProgram, checkPreflight } from "../../../packages/compiler/src/frontend/program.js";
import type { FrontendServices } from "../../../packages/compiler/src/frontend/services.js";
import { CAUGHT, F64, STRING, VOID, type IrLocal } from "../../../packages/compiler/src/ir/ir.js";
import {
  bindingInContext, captureContextBinding, declareContextLocal, declareContextThis, newFnCtx,
} from "../../../packages/compiler/src/frontend/lowering/function-context.js";

function requireValue(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** Exercise production context operations with canonical checker symbols.
 * The separate corpus tests execute the resulting closures; this fixture
 * proves that the compiler's own storage and capture machinery runs natively. */
function runContextCase(services: FrontendServices, entry: string): string[] {
  const load = loadProgram(entry, services);
  try {
    requireValue(checkPreflight(load).length === 0, "input failed preflight");
    const checker = load.program.getTypeChecker();
    const declarations: ts.Node[] = [];
    ts.walkPreorder(load.entry, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.push(node.name);
    });
    const symbols: ts.Symbol[] = [];
    for (const declaration of declarations) {
      const symbol = checker.getSymbolAtLocation(declaration);
      if (symbol === undefined) throw new Error("missing declaration symbol");
      symbols.push(symbol);
    }
    requireValue(symbols.length === 3, "expected three source bindings");
    const outerSymbol = symbols[0]!;
    const shadowSymbol = symbols[1]!;
    const unusedSymbol = symbols[2]!;
    requireValue(outerSymbol !== shadowSymbol, "shadowed bindings share identity");
    requireValue(ts.symbolName(outerSymbol) === ts.symbolName(shadowSymbol), "fixture did not shadow a name");
    const source = bindingSource(declarations[0]!);
    const root = newFnCtx(false, null, null, VOID);
    const outer = declareContextLocal(root, "value", F64, true, outerSymbol, source);
    const hidden = declareContextLocal(root, "value", STRING, false, undefined, undefined);
    requireValue(outer.id === "value.0" && hidden.id === "value.1", "local counters collide");
    requireValue(bindingInContext(root, outerSymbol) === outer, "hidden local replaced binding");
    requireValue(bindingInContext(root, unusedSymbol) === null, "missing symbol found a binding");
    root.scopes.push(new Map());
    const shadow = declareContextLocal(root, "value", STRING, false, shadowSymbol, bindingSource(declarations[1]!));
    requireValue(shadow.id === "value.2", "shadowed local reused an identifier");
    requireValue(bindingInContext(root, shadowSymbol) === shadow, "shadow lookup failed");
    requireValue(bindingInContext(root, outerSymbol) === outer, "shadow hid another symbol");
    root.scopes.pop();
    requireValue(bindingInContext(root, shadowSymbol) === null, "popped scope retained binding");
    const thisLocal = declareContextThis(root, { kind: "object", className: "Example" });
    requireValue(bindingInContext(root, undefined) === thisLocal, "this binding missing");
    requireValue(root.scopes[0]!.size === 1, "this entered the checker symbol map");

    const middle = newFnCtx(true, null, null, VOID);
    const child = newFnCtx(true, null, null, F64);
    // A hidden local with the capture's spelling must keep its identifier.
    declareContextLocal(middle, "value", STRING, false, undefined, undefined);
    const stack = [root, middle, child];
    const parents: IrLocal[] = [];
    const children: IrLocal[] = [];
    const capture = (parent: IrLocal, local: IrLocal): void => {
      parents.push(parent);
      children.push(local);
    };
    const captured = captureContextBinding(stack, outerSymbol, capture);
    requireValue(captured.error === null && captured.local !== null, "capture failed");
    const local = captured.local!;
    requireValue(outer.boxed === true && local.boxed === true, "capture did not box storage");
    requireValue(local.mutable && local.type.kind === "f64", "capture lost binding type");
    requireValue(local.source === source, "capture lost source identity");
    requireValue(middle.captureSources[0] === "value.0" && child.captureSources[0] === "value.1", "capture chain skipped a context");
    requireValue(parents.length === 2 && children.length === 2, "capture edges were not reported");
    requireValue(parents[0] === outer && parents[1] === children[0] && children[1] === local, "capture edges lost identity");
    requireValue(bindingInContext(child, outerSymbol) === local, "captured binding not cached");
    const repeated = captureContextBinding(stack, outerSymbol, capture);
    requireValue(repeated.local === local && children.length === 2, "repeat lookup allocated another capture");

    const capturedThis = captureContextBinding(stack, undefined, capture);
    requireValue(capturedThis.error === null && capturedThis.local === child.thisLocal, "lexical this did not reach child");
    requireValue(thisLocal.boxed === true && middle.thisLocal?.boxed === true, "this origin was not boxed");
    requireValue(child.captureBySymbol.size === 1, "this polluted symbol capture keys");
    requireValue(child.captures?.length === 2 && child.captureSources[1] === "this.0", "this capture order changed");
    requireValue(captureContextBinding(stack, undefined, capture).local === capturedThis.local, "this capture duplicated");
    requireValue(children.length === 4, "this captured more than once");

    const sibling = newFnCtx(true, null, null, VOID);
    const siblingCapture = captureContextBinding([root, sibling], outerSymbol, capture);
    requireValue(siblingCapture.local !== local && siblingCapture.origin === outer, "sibling captures shared a local slot");
    requireValue(sibling.captureSources[0] === outer.id, "sibling did not capture the original binding");
    // A nested method supplies its own this even when enclosed by a method.
    const method = newFnCtx(false, null, null, VOID);
    const ownThis = declareContextThis(method, { kind: "object", className: "Nested" });
    const arrow = newFnCtx(true, null, null, VOID);
    const nestedThis = captureContextBinding([root, method, arrow], undefined, capture);
    requireValue(nestedThis.origin === ownThis && nestedThis.local === arrow.thisLocal, "nested method captured outer this");
    requireValue(arrow.thisLocal?.type.kind === "object", "this capture lost class type");

    // Contexts for separate generic specializations reuse checker symbols
    // while allocating independent local names, scopes, and captures.
    const specialization = newFnCtx(false, null, null, STRING);
    const specialized = declareContextLocal(specialization, "value", STRING, false, outerSymbol, source);
    requireValue(specialized !== outer && specialized.id === "value.0", "specialization reused storage");
    requireValue(bindingInContext(specialization, outerSymbol) === specialized, "specialization lookup escaped");
    const specializedChild = newFnCtx(true, null, null, VOID);
    const specializedCapture = captureContextBinding([specialization, specializedChild], outerSymbol, capture);
    requireValue(specializedCapture.local?.type.kind === "string", "specialization inherited another type");
    requireValue(!specializedCapture.local?.mutable, "specialization inherited mutable storage");

    const forward = newFnCtx(false, null, null, VOID);
    const forwardLocal = declareContextLocal(forward, "later", STRING, false, unusedSymbol, source);
    forwardLocal.boxed = true;
    forwardLocal.tdz = true;
    forward.tdzPredeclared.set(unusedSymbol, forwardLocal);
    const forwardMiddle = newFnCtx(true, null, null, VOID);
    const forwardChild = newFnCtx(true, null, null, VOID);
    const forwardCapture = captureContextBinding([forward, forwardMiddle, forwardChild], unusedSymbol, capture);
    requireValue(forwardCapture.local?.tdz === true && forwardMiddle.captureBySymbol.get(unusedSymbol)?.tdz === true, "TDZ marker lost in capture chain");
    requireValue(forwardCapture.local?.source === source, "TDZ capture lost source metadata");
    requireValue(forward.tdzPredeclared.get(unusedSymbol) === forwardLocal, "capture replaced forward declaration");
    const hoisted = newFnCtx(false, null, null, VOID);
    const hoistedLocal = declareContextLocal(hoisted, "variable", F64, true, unusedSymbol, source);
    hoisted.hoistedVars.set(unusedSymbol, hoistedLocal);
    const hoistedChild = newFnCtx(true, null, null, VOID);
    const hoistedCapture = captureContextBinding([hoisted, hoistedChild], unusedSymbol, capture);
    requireValue(hoistedCapture.local?.tdz === undefined, "var capture acquired a TDZ");
    requireValue(hoisted.hoistedVars.get(unusedSymbol) === hoistedLocal, "hoisted binding replaced");

    const caught = newFnCtx(false, null, null, VOID);
    const caughtLocal = declareContextLocal(caught, "caught", CAUGHT, false, outerSymbol, source);
    const caughtChild = newFnCtx(true, null, null, VOID);
    const caughtResult = captureContextBinding([caught, caughtChild], outerSymbol, capture);
    requireValue(caughtResult.error === null && caughtResult.origin === caughtLocal, "catch capture lost its source binding");
    requireValue(caughtLocal.boxed === true && caughtChild.captures?.length === 1, "catch capture did not allocate shared storage");
    const plain = newFnCtx(false, null, null, VOID);
    const plainResult = captureContextBinding([root, plain], outerSymbol, capture);
    requireValue(plainResult.error === "plain" && plainResult.local === null, "plain function accepted captures");
    const missing = captureContextBinding([newFnCtx(true, null, null, VOID)], unusedSymbol, capture);
    requireValue(missing.local === null && missing.error === null, "missing symbol was not left for forward declaration");
    const missingThis = captureContextBinding([newFnCtx(true, null, null, VOID)], undefined, capture);
    requireValue(missingThis.local === null && missingThis.error === null, "missing this acquired storage");
    const self = newFnCtx(true, outerSymbol, { kind: "func", params: [], ret: F64 }, F64);
    requireValue(self.selfSymbol === outerSymbol && self.selfType?.kind === "func", "self-reference metadata lost");
    requireValue(self.captureBySymbol.size === 0, "self binding became a capture");
    return [
      "symbol identity", "scope lifetime", "local counters", "capture chain", "capture reuse",
      "lexical this", "method this", "sibling ownership", "specialization ownership",
      "source metadata", "forward TDZ", "hoisted var", "catch boundary", "plain boundary",
      "missing binding", "self-reference",
    ];
  } finally { load.dispose(); }
}

export function runLoweringContexts(services: FrontendServices, entry: string, output: string): void {
  const first = runContextCase(services, entry);
  // A second load gets a new semantic project. All context caches must be
  // owned by that pass even when its source names and symbol ids repeat.
  const second = runContextCase(services, entry);
  writeFileSync(output, JSON.stringify({ first, second }));
}
