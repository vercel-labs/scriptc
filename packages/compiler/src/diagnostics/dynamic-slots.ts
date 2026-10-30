/* SC6104, the dynamic-slot performance warning (localized-failure design
 * §3.9): a slot whose declared TypeScript type has no static lowering holds
 * a checked-dynamic value instead of rejecting the declaration around it.
 * Its wording lives here; the slots come from the lowering's commit points
 * (Lowerer.degradeAtCommit). Imports nothing heavy, like dynamic-tier.ts. */
import type { SrcLoc } from "../ir/ir.js";
import type { ScrDiagnostic, TypeFailureSlot } from "./diagnostic.js";

export const DYNAMIC_SLOT_CODE = "SC6104";

/** One dynamic slot, as coverage reports it. */
export interface DynamicSlotEntry {
  loc: SrcLoc;
  name: string;
  slot: TypeFailureSlot;
  declaredType: string;
  /** The diagnostic the slot's declaration would have failed with. */
  code: string;
  reason: string;
  /** Push-down: the slot keeps its type's compilable shape, and only the
   * components that do not compile are checked-dynamic. */
  partial?: boolean;
  /** Dynamic operations the program performs on the slot's values (the
   * dynamic-tier sites whose cause names it). */
  operations?: number;
}

const SLOT_WORD: Record<TypeFailureSlot, string> = {
  field: "field",
  param: "parameter",
  return: "return value of",
  local: "local",
  global: "module global",
  loop: "loop variable",
  member: "member",
  expression: "expression",
};

/** `'_customTools' (declared 'ToolDefinition[]')`, with the slot kind. */
export function dynamicSlotLabel(entry: DynamicSlotEntry): string {
  return `${SLOT_WORD[entry.slot]} '${entry.name}' (declared '${entry.declaredType}')`;
}

export function dynamicSlotDiag(entry: DynamicSlotEntry): ScrDiagnostic {
  return {
    code: DYNAMIC_SLOT_CODE,
    message:
      entry.partial === true
        ? `${dynamicSlotLabel(entry)} keeps its compilable shape with checked-dynamic pieces where its type has no static lowering (${entry.reason}); reads of those pieces into typed code are checked`
        : `${dynamicSlotLabel(entry)} is held as a checked-dynamic value: its type has no static lowering (${entry.reason}); reads into typed code are checked`,
    loc: entry.loc,
    hint: "restate the declared type inside the compilable set to keep this slot static; scriptc coverage lists dynamic slots, and --fail-on=dynamic-slots fails on them",
  };
}

export function isDynamicSlotCode(code: string): boolean {
  return code === DYNAMIC_SLOT_CODE;
}
