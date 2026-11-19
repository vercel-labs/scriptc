/* The mutable-buffers fact (t262-dc §2.4): a JavaScript source that can
 * change an ArrayBuffer's length or detach it — `new ArrayBuffer(len, {
 * maxByteLength })`, or a read of `transfer`, `transferToFixedLength`,
 * `resize` or `grow` on any receiver. The name match is deliberate: the
 * receiver may be a checked-dynamic value, and a false positive costs only
 * the invariant metadata of that one program.
 *
 * The fact sets IrModule.bytesHeadersMutable (the backend drops
 * `!invariant.load` on bytes headers and stops proving lengths across
 * calls) and arms scr_js_buffers's views registry in %main, which is what
 * selects the unit's runtime feature. Programs without it keep their exact
 * IR and runtime objects. */
import {
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type SrcLoc,
} from "../../ir/ir.js";
import * as ts from "../ts7/adapter.js";
import { isJsSourceFile } from "../program.js";
import { ENTRY_NAME, type Lowerer } from "./lowerer.js";

/** Member names whose call can change a buffer's length or detach it. */
export const MUTABLE_BUFFER_MEMBERS: ReadonlySet<string> = new Set([
  "transfer",
  "transferToFixedLength",
  "resize",
  "grow",
]);

/** The fact over the whole program: whether a JavaScript source reads one of
 * the member names (a property read or call, a literal element key, or the
 * left side of an `in`). Every site that lowers under the fact — a typed
 * array's callback helper, the bytes headers' invariance — must see the same
 * answer, whichever order the source spells the mutation and the uses in:
 * the lowering hooks set the fact when they pass, and this scan settles it
 * before the first body lowers. */
export function programMentionsMutableBuffers(lowerer: Lowerer): boolean {
  // The files this lowering walks: the entry and the modules in lowering
  // order, dependencies included. They are the files the hooks below can fire
  // in, so they are the files that decide the fact; a white-box test's stub
  // program answers with the one file it lowered.
  const files = lowerer.moduleOrder.includes(lowerer.entry)
    ? lowerer.moduleOrder
    : [lowerer.entry, ...lowerer.moduleOrder];
  for (const sf of files) {
    // Only JavaScript: a declaration has no body to lower, and the hooks fire
    // on the code that lowers, not on every file in the program. Under-arming
    // would be a silent divergence, and a false positive costs only this
    // program's invariant metadata.
    if (sf.isDeclarationFile || !isJsSourceFile(sf)) continue;
    const text = sf.text;
    if (!text.includes("transfer") && !text.includes("resize") && !text.includes("grow")) continue;
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isPropertyAccessExpression(node)) {
        // A WRITE to the member (`exports.grow = ...`) is not a buffer
        // mutation and never reaches the read hook either.
        const parent = node.parent;
        const writeTarget =
          parent !== undefined &&
          ((ts.isBinaryExpression(parent) &&
            parent.left.index === node.index &&
            parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
            ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
              (parent.operator === ts.SyntaxKind.PlusPlusToken ||
                parent.operator === ts.SyntaxKind.MinusMinusToken)));
        if (!writeTarget && MUTABLE_BUFFER_MEMBERS.has(node.name.text)) found = true;
      } else if (ts.isElementAccessExpression(node)) {
        const key = node.argumentExpression;
        if (ts.isStringLiteralLike(key) && MUTABLE_BUFFER_MEMBERS.has(key.text)) found = true;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword
      ) {
        const key = node.left;
        if (ts.isStringLiteralLike(key) && MUTABLE_BUFFER_MEMBERS.has(key.text)) found = true;
      }
      if (!found) ts.forEachChild(node, visit);
    };
    visit(sf);
    if (found) return true;
  }
  return false;
}

/** Installs the registry arming call at the top of %main; answers whether
 * the program has an entry function to carry it. The fact itself
 * (lowerer.buffersMutable) is complete by the time a program is assembled:
 * every member read and every resizable construction has been lowered. */
export function installMutableBuffersArm(functions: IrFunction[]): boolean {
  const main = functions.find((fn) => fn.name === ENTRY_NAME);
  if (!main) return false;
  main.body.unshift({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "arrayBuffer.armMutable",
      args: [],
      type: VOID,
      loc: main.loc,
    },
    loc: main.loc,
  });
  return true;
}

/** Node's ValidateTypedArray at a builtin whose visit or sort is empty for
 * a detached receiver (t262-dc2): `sort`, `toSorted` and the iterator
 * factories (`values`/`keys`/`entries`, a for-of head) throw before they
 * read %TypedArrayLength, so the check cannot hang off a loop bound the way
 * a callback's can. Emitted as the first statement of the lifted helper or
 * the loop block that receives the receiver. Every caller gates on
 * `lowerer.buffersMutable`, so other programs emit nothing at all. */
export function requireLiveBytes(receiver: IrExpr, method: string, loc: SrcLoc): IrStmt {
  return {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "bytes.requireLive",
      args: [receiver, { kind: "strLit", value: method, type: STRING, loc }],
      type: VOID,
      loc,
    },
    loc,
  };
}
