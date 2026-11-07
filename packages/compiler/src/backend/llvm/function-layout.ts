/** Function layouts: the functions that runs of a program execute, in tiers
 * (scripts/refresh-cli-layout.mjs writes the native compiler's). The emitter
 * writes a listed function before the others, in a partition group of its
 * tier, so the code that runs together sits together in the executable.
 *
 * Tier 0 is the start-up tier: the functions a plain program run reaches
 * before it does any work. The emitter puts them in STARTUP_SECTION and writes
 * them first, in the order a breadth-first walk from the entry reaches them, so
 * the linker places their start-up code ahead of the rest: a short run then
 * faults in one contiguous block of the image instead of a window almost
 * everywhere in it. */

/** Layout key → tier (0 is start-up, then 1). */
export type FunctionLayout = ReadonlyMap<string, number>;

/** The start-up tier. */
export const STARTUP_TIER = 0;

/** The section of the start-up tier's functions. Linkers place it before the
 * other code text: lld by `--symbol-ordering-file` (link-plan), GNU ld and
 * zig's linker by their default script. */
export const STARTUP_SECTION = ".text.startup";

/** How the start-up symbols travel from the emitter to the link line: one
 * comment line the module text carries, listing them in emission order
 * (emit-module.ts writes it). */
export const STARTUP_ORDER_MARKER = "; scriptc-startup";

/** The layout key of an LLVM symbol: module numbers (`%m12.`, `%init.12`),
 * which change when modules are added, are left out. */
export function functionLayoutKey(symbol: string): string {
  return symbol.replace(/_x25_m\d+_/g, "_x25_m_").replace(/_x25_init_\d+$/, "_x25_init_");
}

/** Reads a layout's lines, each `<tier> <symbol>`. A function listed in two
 * tiers keeps the first (tier 0 lines are written first). */
export function parseFunctionLayout(text: string): FunctionLayout {
  const layout = new Map<string, number>();
  for (const line of text.split("\n")) {
    const space = line.indexOf(" ");
    if (space < 1) continue;
    const tier = Number(line.slice(0, space));
    const key = functionLayoutKey(line.slice(space + 1).trim());
    if (Number.isInteger(tier) && tier >= 0 && !layout.has(key)) layout.set(key, tier);
  }
  return layout;
}

/** Whether a layout puts the function an LLVM symbol names in the start-up
 * tier. */
export function isStartupFunction(layout: FunctionLayout | undefined, symbol: string): boolean {
  return layout?.get(functionLayoutKey(symbol)) === STARTUP_TIER;
}

/** Whether a layout has a start-up tier at all. */
export function hasStartupTier(layout: FunctionLayout | undefined): boolean {
  if (layout === undefined) return false;
  for (const tier of layout.values()) if (tier === STARTUP_TIER) return true;
  return false;
}

const STARTUP_LINE = new RegExp(`^${STARTUP_ORDER_MARKER}(?: (.*))?$`, "gm");

/** The start-up symbols a module text carries, in the order it wrote their
 * definitions: the list on its STARTUP_ORDER_MARKER lines (a module can carry
 * more than one, for definitions it emits after the others), empty when it has
 * none. */
export function startupSymbolsOf(llvm: string | readonly string[]): string[] {
  const symbols: string[] = [];
  for (const part of typeof llvm === "string" ? [llvm] : llvm)
    for (const match of part.matchAll(STARTUP_LINE))
      for (const symbol of (match[1] ?? "").split(" ")) if (symbol !== "") symbols.push(symbol);
  return symbols;
}

/** The section attribute a start-up definition's header line carries. */
const STARTUP_ATTRIBUTE = `section "${STARTUP_SECTION}"`;

/** The symbol a definition's text defines. */
const DEFINED_SYMBOL = /^define [^@\n]*@([A-Za-z0-9_.$-]+)\(/;

/** A function a module text declares and does not define: its code comes from
 * the runtime pack or the C library. */
const DECLARED_SYMBOL = /^declare [^@\n]*@([A-Za-z0-9_.$-]+)\(/;

/** A direct call's callee in a definition's text. */
const DIRECT_CALLEE = /(?:call|invoke)[^\n]*?@([A-Za-z0-9_.$-]+)\(/g;

/** The symbol `text` defines, or undefined when it defines none. */
export function definedSymbol(text: string): string | undefined {
  return DEFINED_SYMBOL.exec(text)?.[1];
}

/** The runtime-pack functions `texts`' start-up definitions call directly, in
 * the order their first call reaches them. Their code is not in `texts` but in
 * the pack, so the module text cannot section it; naming the symbols to the
 * linker puts them after the start-up block instead of leaving one window of
 * the pack to fault in per function. */
export function startupCalleesOf(texts: readonly string[]): string[] {
  const declared = new Set<string>();
  const defined = new Set<string>();
  for (const text of texts) {
    for (const line of text.split("\n")) {
      const declaration = DECLARED_SYMBOL.exec(line)?.[1];
      if (declaration !== undefined) declared.add(declaration);
      const definition = DEFINED_SYMBOL.exec(line)?.[1];
      if (definition !== undefined) defined.add(definition);
    }
  }
  const callees: string[] = [];
  const seen = new Set(defined);
  for (const text of texts) {
    let startup = false;
    for (const line of text.split("\n")) {
      if (line.startsWith("define ")) {
        startup = line.includes(STARTUP_ATTRIBUTE);
        continue;
      }
      if (!startup) continue;
      for (const match of line.matchAll(DIRECT_CALLEE)) {
        const symbol = match[1]!;
        // The pack's symbols carry its `scr_` prefix; the C library's code sits
        // in the CRT's own place, out of the ordering file's reach.
        if (!symbol.startsWith("scr_") || !declared.has(symbol) || seen.has(symbol)) continue;
        seen.add(symbol);
        callees.push(symbol);
      }
    }
  }
  return callees;
}

/** The ranks of `texts` in the order a breadth-first walk of their direct calls
 * first reaches them, from the entry and the initialisers. A text no walk
 * reaches ranks after the ones it does, and the walk keeps `texts`' order among
 * functions it reaches at the same depth. `roots` names the entry and the
 * initialisers by their texts, for a walk over a subset that leaves them out. */
export function firstReachRanks(texts: readonly string[], roots: readonly string[] = []): number[] {
  const symbols = texts.map(definedSymbol);
  const index = new Map<string, number>();
  symbols.forEach((symbol, i) => {
    if (symbol !== undefined && !index.has(symbol)) index.set(symbol, i);
  });
  const calleesOf = (text: string): number[] => {
    const found: number[] = [];
    for (const match of text.matchAll(DIRECT_CALLEE)) {
      const target = index.get(match[1]!);
      if (target !== undefined) found.push(target);
    }
    return found;
  };
  const callees = texts.map(calleesOf);
  const ranks: number[] = texts.map(() => Number.POSITIVE_INFINITY);
  const queue: number[] = [];
  let reached = 0;
  const visit = (i: number): void => {
    if (ranks[i] !== Number.POSITIVE_INFINITY) return;
    ranks[i] = reached++;
    queue.push(i);
  };
  symbols.forEach((symbol, i) => {
    const entry =
      symbol !== undefined &&
      (symbol === "main" || symbol.includes("_x25_main") || symbol.includes("_x25_init_"));
    if (entry) visit(i);
  });
  for (const text of roots) {
    const symbol = definedSymbol(text);
    if (symbol !== undefined && index.has(symbol)) continue;
    for (const i of calleesOf(text)) visit(i);
  }
  for (let head = 0; head < queue.length; head++) for (const i of callees[queue[head]!]!) visit(i);
  return ranks;
}

/** The lowest tier of the functions `text` defines, or undefined when the
 * layout lists none of them. */
export function layoutTierOf(layout: FunctionLayout, text: string): number | undefined {
  let tier: number | undefined;
  for (let at = text.indexOf("define "); at >= 0; at = text.indexOf("\ndefine ", at + 1)) {
    const name = text.indexOf("@", at);
    const open = text.indexOf("(", name);
    if (name < 0 || open < 0) break;
    const listed = layout.get(functionLayoutKey(text.slice(name + 1, open)));
    if (listed !== undefined && (tier === undefined || listed < tier)) tier = listed;
  }
  return tier;
}
