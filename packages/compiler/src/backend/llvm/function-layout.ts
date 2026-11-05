/** Function layouts: the functions that runs of a program execute, in tiers
 * (scripts/refresh-cli-layout.mjs writes the native compiler's). The emitter
 * writes a listed function before the others, in a partition group of its
 * tier, so the code that runs together sits together in the executable. */

/** Layout key → tier (1 first). */
export type FunctionLayout = ReadonlyMap<string, number>;

/** The layout key of an LLVM symbol: module numbers (`%m12.`, `%init.12`),
 * which change when modules are added, are left out. */
export function functionLayoutKey(symbol: string): string {
  return symbol.replace(/_x25_m\d+_/g, "_x25_m_").replace(/_x25_init_\d+$/, "_x25_init_");
}

/** Reads a layout's lines, each `<tier> <symbol>`. A function listed in two
 * tiers keeps the first. */
export function parseFunctionLayout(text: string): FunctionLayout {
  const layout = new Map<string, number>();
  for (const line of text.split("\n")) {
    const space = line.indexOf(" ");
    if (space < 1) continue;
    const tier = Number(line.slice(0, space));
    const key = functionLayoutKey(line.slice(space + 1).trim());
    if (Number.isInteger(tier) && tier > 0 && !layout.has(key)) layout.set(key, tier);
  }
  return layout;
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
