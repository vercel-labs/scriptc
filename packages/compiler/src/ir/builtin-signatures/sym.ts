import { DYN, STRING, SYMBOL_T, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The sym builtin call slots. */
export const symSignatures = defineLibFnSignatures({
  /** ES Symbol values (scr_symbol.c — link-gated by moduleUsesSymbol).
   * sym.new: `Symbol(desc)` — a fresh runtime-unique identity (+1) whose
   * one arg is the description string (borrowed); sym.newAnon is the
   * description-less `Symbol()` form. sym.for: the Symbol.for global
   * registry — one interned symbol per key (borrowed), +1 on every call.
   * sym.toString: "Symbol(desc)" (+1 string; "Symbol()" when absent).
   * sym.desc / sym.keyFor answer the interned `string | undefined` union
   * (the runtime returns +1-or-NULL; the backend builds the union arms —
   * the child.stdout pattern). None of these throw. */
  "sym.new": { argTypes: [STRING], result: SYMBOL_T },
  "sym.newAnon": { argTypes: [], result: SYMBOL_T },
  "sym.for": { argTypes: [STRING], result: SYMBOL_T },
  "sym.wellKnown": { argTypes: [STRING], result: SYMBOL_T },
  // Result is the interned `string | undefined` union — the libCall case
  // checks the arms (the spawnRes.error pattern).
  "sym.keyFor": { argTypes: [SYMBOL_T], result: VOID },
  "sym.desc": { argTypes: [SYMBOL_T], result: VOID },
  "sym.toString": { argTypes: [SYMBOL_T], result: STRING },
  /** Symbol.keyFor called through its function value: the key or
   * undefined, or Node's TypeError for a value that is not a symbol. */
  "sym.keyForDyn": { argTypes: [DYN], result: DYN },
});
