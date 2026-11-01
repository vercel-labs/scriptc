import * as ts from "../ts7/adapter.js";
import { typeEquals, typeKey, UNDEFINED_T } from "../../ir/ir.js";
import type { IrType, SrcLoc } from "../../ir/ir.js";
import type { RuntimeOptionalDecision } from "./runtime-optional-provenance.js";
import type { Lowerer } from "./lowerer.js";

/** One runtime-optional storage decision as the coverage report presents
 * it: the widened slot, the decision that widened it, and the reads where
 * the checker types the slot narrower than its storage — the narrowing the
 * widened representation has to undo at the read. */
export interface RuntimeOptionalNarrowing {
  /** The widened binding or parameter. */
  name: string;
  /** The storage type lowering reads, such as `number | undefined`. */
  storage: string;
  /** The checker's type at the narrowed reads, such as `number`. */
  narrowed: string;
  /** Every read the checker types narrower than the storage, in source
   * order. */
  reads: SrcLoc[];
  /** The storage decisions that widened the slot, in source order. */
  decisions: RuntimeOptionalDecisionInfo[];
}

export interface RuntimeOptionalDecisionInfo {
  /** The decision kind, such as `binding` or `parameter`. */
  kind: string;
  /** The widened slot. */
  target: SrcLoc;
  /** The expression or site whose value made the slot optional. */
  cause: SrcLoc | null;
  /** A qualifier such as an element key. */
  detail: string;
}

/** The runtime-optional slots whose storage holds an absence the checker's
 * type does not admit, with the reads at which the checker narrows the
 * slot below that storage. Report-only: nothing here changes lowering.
 *
 * The indexed-read analysis widens a binding or parameter so it can hold a
 * value an unchecked read left undefined; the checker still types every
 * read with the declared type, so a read of such a slot extracts the
 * payload through a checked narrowing. The decisions recorded alongside
 * the widening name the expression that made the slot optional. */
export function runtimeOptionalNarrowings(
  lowerer: Lowerer,
  files: readonly ts.SourceFile[],
): RuntimeOptionalNarrowing[] {
  const bindings = lowerer.runtimeOptionalBindingTypes;
  if (bindings.size === 0) return [];
  const decisions = lowerer.runtimeOptionalProvenance?.decisions() ?? [];
  const decisionsBySymbol = new Map<ts.Symbol, RuntimeOptionalDecision[]>();
  for (const decision of decisions) {
    const symbol = decisionSymbol(lowerer, decision.targetNode);
    if (!symbol) continue;
    const list = decisionsBySymbol.get(symbol);
    if (list) list.push(decision);
    else decisionsBySymbol.set(symbol, [decision]);
  }
  const reads = new Map<ts.Symbol, { narrowed: Map<string, IrType>; locs: Map<string, SrcLoc> }>();
  for (const sf of files) {
    ts.walkPreorder(sf, (node) => {
      if (!ts.isIdentifier(node) || !isBindingRead(node)) return undefined;
      const symbol = symbolOf(lowerer, node);
      if (!symbol) return undefined;
      const storage = bindings.get(symbol);
      if (!storage) return undefined;
      const narrowed = narrowingBelow(lowerer, symbol, storage, node);
      if (!narrowed) return undefined;
      const loc: SrcLoc = {
        file: sf.fileName,
        start: ts.tokenStartOfNode(node),
        end: node.end,
      };
      let entry = reads.get(symbol);
      if (!entry) {
        entry = { narrowed: new Map(), locs: new Map() };
        reads.set(symbol, entry);
      }
      entry.narrowed.set(typeKey(narrowed), narrowed);
      entry.locs.set(`${loc.file}:${loc.start}`, loc);
      return undefined;
    });
  }
  const out: RuntimeOptionalNarrowing[] = [];
  for (const [symbol, entry] of reads) {
    const storage = bindings.get(symbol)!;
    const locs = [...entry.locs.values()].sort(compareLocs);
    out.push({
      name: symbolName(symbol),
      storage: storageText(lowerer, symbol, storage),
      narrowed: [...entry.narrowed.values()].map((t) => describeIrType(lowerer, t)).join(" or "),
      reads: locs,
      decisions: (decisionsBySymbol.get(symbol) ?? []).flatMap((decision) =>
        decision.targetNode === undefined ? [] : [decisionInfo(decision, decision.targetNode)],
      ),
    });
  }
  out.sort((a, b) => compareLocs(a.reads[0]!, b.reads[0]!));
  return out;
}

function compareLocs(a: SrcLoc, b: SrcLoc): number {
  return a.file === b.file ? a.start - b.start : a.file < b.file ? -1 : 1;
}

function decisionInfo(
  decision: RuntimeOptionalDecision,
  target: ts.Node,
): RuntimeOptionalDecisionInfo {
  return {
    kind: decision.kind,
    target: nodeLoc(target),
    cause: decision.causeNode ? nodeLoc(decision.causeNode) : null,
    detail: decision.detail,
  };
}

function nodeLoc(node: ts.Node): SrcLoc {
  return {
    file: ts.getSourceFileOfNode(node).fileName,
    start: ts.tokenStartOfNode(node),
    end: node.end,
  };
}

/** The binding or parameter a decision target names. Field and return
 * decisions name a member or a function, which the binding scan does not
 * join. */
function decisionSymbol(lowerer: Lowerer, target: ts.Node | undefined): ts.Symbol | null {
  if (!target) return null;
  if (ts.isParameter(target) || ts.isBindingElement(target) || ts.isVariableDeclaration(target)) {
    if (!ts.isIdentifier(target.name)) return null;
    return symbolOf(lowerer, target.name);
  }
  if (!ts.isIdentifier(target)) return null;
  return symbolOf(lowerer, target);
}

/** The checker's symbol for a value reference, resolved through aliases
 * like the analysis does. An object shorthand (`{ v }`) names the member it
 * creates, so its own location resolves to the property symbol; the value is
 * the binding read behind it. The lowerer's own resolution flushes deferred
 * diagnostics; a report must not change the build. */
function symbolOf(lowerer: Lowerer, node: ts.Node): ts.Symbol | null {
  const parent = node.parent;
  const symbol =
    parent !== undefined &&
    ts.isIdentifier(node) &&
    ts.isShorthandPropertyAssignment(parent) &&
    parent.name === node
      ? (lowerer.checker.getShorthandAssignmentValueSymbol(parent) ??
        lowerer.checker.getSymbolAtLocation(node))
      : lowerer.checker.getSymbolAtLocation(node);
  if (!symbol) return null;
  return symbol.flags & ts.SymbolFlags.Alias ? lowerer.checker.getAliasedSymbol(symbol) : symbol;
}

/** An identifier reading a binding: not a member name, a declaration name,
 * a type reference, or a store target. */
function isBindingRead(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent)) return false;
  if (declaresName(parent, node)) return false;
  if (inTypePosition(node)) return false;
  if (storesTo(node)) return false;
  return true;
}

/** Whether the identifier names a type rather than a value: an annotation
 * (`let x: typeof y`), a type query, `as`/`satisfies`, or a type argument.
 * A type reference is not a read of the widened storage. */
function inTypePosition(node: ts.Node): boolean {
  let current = node;
  let parent = current.parent;
  while (parent !== undefined) {
    if (ts.isTypeNode(parent)) return true;
    // A declaration's annotation, a return type, `as` and `satisfies` hold
    // their type in a `type` child.
    if ((parent as { type?: ts.Node }).type === current) return true;
    if (ts.isExpression(parent) || ts.isStatement(parent)) return false;
    current = parent;
    parent = current.parent;
  }
  return false;
}

/** Whether the identifier is the name a declaration introduces (a binding,
 * member, label or type), rather than a reference to one. A shorthand
 * property (`{ v }`) names its member and reads the binding. */
function declaresName(parent: ts.Node, node: ts.Node): boolean {
  if (ts.isShorthandPropertyAssignment(parent)) return false;
  if ((parent as { name?: ts.Node }).name === node) return true;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent))
    return parent.propertyName === node;
  return false;
}

/** A store target (`x = ...`, `x++`, `delete x`) is not a read whose
 * checker type lowering has to narrow. */
function storesTo(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isBinaryExpression(parent)) {
    if (parent.left !== node) return false;
    const op = parent.operatorToken.kind;
    return op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment;
  }
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
    return (
      parent.operand === node &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken)
    );
  if (ts.isDeleteExpression(parent)) return parent.expression === node;
  return false;
}

/** The narrowing the checker applies at this read, or null when the read
 * does not go below the widened storage. A slot whose checker type already
 * admits undefined has a visible absent arm; TypeScript's ordinary
 * control-flow narrowing of it is not a runtime-optional widening. */
function narrowingBelow(
  lowerer: Lowerer,
  symbol: ts.Symbol,
  storage: IrType,
  node: ts.Identifier,
): IrType | null {
  if (storage.kind === "dyn") {
    const checkerType = lowerer.checker.getTypeOfSymbol(symbol);
    if (checkerType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return null;
    const narrowed = lowerer.mapTypeOf(lowerer.typeOf(node));
    return narrowed && narrowed.kind !== "dyn" ? narrowed : null;
  }
  if (storage.kind !== "union") return null;
  if (lowerer.armTag(storage.unionId, UNDEFINED_T) < 0) return null;
  if (checkerAdmitsUndefined(lowerer.checker.getTypeOfSymbol(symbol))) return null;
  const narrowed = lowerer.mapTypeOf(lowerer.typeOf(node));
  if (!narrowed || narrowed.kind === "dyn") return null;
  if (typeEquals(narrowed, lowerer.stripUndefinedArm(storage))) return narrowed;
  if (lowerer.armTag(storage.unionId, narrowed) >= 0) return narrowed;
  // A guard can narrow the slot to several storage arms at once
  // (`typeof v === "string" || typeof v === "number"`): the union itself is
  // not an arm, but each of its arms is, so the read is still below the
  // storage the checker called present.
  const narrowedDef = narrowed.kind === "union" ? lowerer.unions.get(narrowed.unionId) : undefined;
  if (narrowedDef && narrowedDef.arms.every((arm) => lowerer.armTag(storage.unionId, arm) >= 0))
    return narrowed;
  return null;
}

function checkerAdmitsUndefined(type: ts.Type): boolean {
  if (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any)) return true;
  return (
    type.isUnionType() &&
    ts
      .constituentTypes(type)
      .some((arm) => (arm.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0)
  );
}

function symbolName(symbol: ts.Symbol): string {
  const name = ts.symbolName(symbol);
  return name.startsWith("#") ? name.slice(1) : name;
}

function storageText(lowerer: Lowerer, symbol: ts.Symbol, storage: IrType): string {
  if (storage.kind === "dyn") return "dynamic";
  const declared = lowerer.checker.typeToString(lowerer.checker.getTypeOfSymbol(symbol));
  if (storage.kind === "union" && lowerer.armTag(storage.unionId, UNDEFINED_T) >= 0)
    return `${declared} | undefined`;
  return describeIrType(lowerer, storage);
}

/** TypeScript-shaped names for the storage a report entry shows. */
function describeIrType(lowerer: Lowerer, t: IrType, depth = 0): string {
  switch (t.kind) {
    case "f64":
      return "number";
    case "bigint":
      return "bigint";
    case "date":
      return "Date";
    case "string":
      return "string";
    case "bool":
      return "boolean";
    case "void":
      return "undefined";
    case "symbol":
      return "symbol";
    case "dyn":
      return "dynamic";
    case "array":
      return depth > 2 ? "an array" : `${describeIrType(lowerer, t.elem, depth + 1)}[]`;
    case "map":
      return depth > 2
        ? "a map"
        : `Map<${describeIrType(lowerer, t.key, depth + 1)}, ${describeIrType(lowerer, t.value, depth + 1)}>`;
    case "set":
      return depth > 2 ? "a set" : `Set<${describeIrType(lowerer, t.elem, depth + 1)}>`;
    case "object":
      return t.className;
    case "func":
      return "a function";
    case "promise":
      return depth > 2 ? "a promise" : `Promise<${describeIrType(lowerer, t.inner, depth + 1)}>`;
    case "union": {
      if (depth > 2) return "a union";
      const def = lowerer.unions.get(t.unionId);
      if (!def) return "a union";
      return def.arms.map((arm) => describeIrType(lowerer, arm, depth + 1)).join(" | ");
    }
    case "record": {
      const shape = lowerer.shapes.get(t.shapeId);
      if (!shape || depth > 2) return "an object";
      return `{ ${shape.fields
        .map((f) => `${f.name}: ${describeIrType(lowerer, f.type, depth + 1)}`)
        .join("; ")} }`;
    }
    default:
      return "a runtime value";
  }
}
