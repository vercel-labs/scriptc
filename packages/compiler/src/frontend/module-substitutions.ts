/* `scriptc.moduleSubstitutions`: a module the project answers with another
 * (a build's platform forks, `Config.js` → `forks/Config.node.js`). The
 * substituted module is served as a re-export of its replacement, so the
 * checker and scriptc's resolver keep the one module path and every
 * importer binds the replacement's exports. */
import { dirname, relative } from "node:path";
import { trackedReadFile } from "./input-tracker.js";

let active: ReadonlyMap<string, string> | null = null;

export function setModuleSubstitutions(map: ReadonlyMap<string, string>): void {
  active = map.size > 0 ? map : null;
}

/** The re-export text served for a substituted module (a `.ts` path also
 * answers for a Flow module presented there), or undefined. */
export function substitutedSource(path: string): string | undefined {
  if (active === null) return undefined;
  const target =
    active.get(path) ?? (path.endsWith(".ts") ? active.get(path.slice(0, -3) + ".js") : undefined);
  if (target === undefined) return undefined;
  let specifier = relative(dirname(path), target).replaceAll("\\", "/");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  const text = trackedReadFile(target) ?? "";
  const hasDefault = /\bexport\s+default\b|\bexport\s*\{[^}]*\bdefault\b/.test(text);
  return `export * from ${JSON.stringify(specifier)};\n${hasDefault ? `export { default } from ${JSON.stringify(specifier)};\n` : ""}`;
}
