/* `scriptc.moduleSubstitutions`: a module the project answers with another
 * (a build's platform forks, `Config.js` → `forks/Config.node.js`). The
 * substituted module is served as a re-export of its replacement, so the
 * checker and scriptc's resolver keep the one module path and every
 * importer binds the replacement's exports. */
import { dirname, relative } from "node:path";
import { trackedReadFile } from "./input-tracker.js";
import { isFlowModule } from "./flow/index.js";

let active: ReadonlyMap<string, string> | null = null;
/** The re-export served at each substituted path, built once per load. */
const served = new Map<string, string>();

export function setModuleSubstitutions(map: ReadonlyMap<string, string>): void {
  active = map.size > 0 ? map : null;
  served.clear();
}

/** The re-export text served for a substituted module (a `.ts` or `.tsx`
 * path also answers for a Flow module presented there), or undefined. */
export function substitutedSource(path: string): string | undefined {
  if (active === null) return undefined;
  const flowBase = path.endsWith(".ts")
    ? path.slice(0, -3)
    : path.endsWith(".tsx")
      ? path.slice(0, -4)
      : null;
  const target =
    active.get(path) ??
    (flowBase !== null && isFlowModule(path) ? active.get(flowBase + ".js") : undefined);
  if (target === undefined) return undefined;
  const cached = served.get(path);
  if (cached !== undefined) return cached;
  let specifier = relative(dirname(path), target).replaceAll("\\", "/");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  const text = withoutComments(trackedReadFile(target) ?? "");
  const hasDefault = /\bexport\s+default\b|\bexport\s*\{[^}]*\bdefault\b/.test(text);
  const source = `export * from ${JSON.stringify(specifier)};\n${hasDefault ? `export { default } from ${JSON.stringify(specifier)};\n` : ""}`;
  served.set(path, source);
  return source;
}

/** The source with its comments removed (string and template contents
 * kept), so a commented-out `export default` does not count. */
function withoutComments(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== null) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      out += " ";
    } else out += c;
  }
  return out;
}
