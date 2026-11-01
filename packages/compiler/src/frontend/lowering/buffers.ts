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
import { VOID, type IrFunction } from "../../ir/ir.js";
import { ENTRY_NAME } from "./lowerer.js";

/** Member names whose call can change a buffer's length or detach it. */
export const MUTABLE_BUFFER_MEMBERS: ReadonlySet<string> = new Set([
  "transfer",
  "transferToFixedLength",
  "resize",
  "grow",
]);

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
