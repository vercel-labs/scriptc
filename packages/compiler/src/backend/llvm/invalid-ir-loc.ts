/* Where an LLVM verifier error happened in the program: the diagnostic the
 * helper reports is about emitted IR ("'void type only allowed for function
 * results', on '%sc_l__x25_destr_0 = alloca void'"), not about a source
 * construct. The compiler wrote that IR, so it can name the construct: the
 * quoted slot is `%sc_l_` plus the mangled local id, and the IR holds the
 * statement that declared or wrote it. Naming the site turns a build error
 * that pointed at the entry (1:1) into an ordinary diagnostic with a code
 * frame of the construct whose lowering emitted the invalid IR. */
import type { IrModule, SrcLoc } from "../../ir/ir.js";
import { everyModuleNode } from "../../ir/traverse.js";
import { mangleLocal } from "../mangle.js";

/** The source site of the local the LLVM error `message` quotes, when it
 * names an emitted local slot; null for a message that names none. A local's
 * declaration wins over a later write, and a parameter's own site is the
 * function's. */
export function invalidIrSourceLoc(mod: IrModule, message: string): SrcLoc | null {
  const quoted = /%sc_l_[A-Za-z0-9_]+/.exec(message);
  if (quoted === null) return null;
  const name = quoted[0].slice(1);
  let declaration: SrcLoc | null = null;
  let write: SrcLoc | null = null;
  everyModuleNode(mod, {
    expr: () => true,
    stmt: (node) => {
      if (node.kind === "varDecl" && mangleLocal(node.localId) === name) {
        if (declaration === null) declaration = node.loc;
      } else if (node.kind === "assign" && mangleLocal(node.localId) === name) {
        if (write === null) write = node.loc;
      }
      return true;
    },
    type: () => true,
  });
  if (declaration !== null || write !== null) return declaration ?? write;
  for (const fn of mod.functions) {
    for (const local of fn.locals) if (mangleLocal(local.id) === name) return fn.loc;
  }
  return null;
}
