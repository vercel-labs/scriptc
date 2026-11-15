/** The command line's package marks other than `--node-island`: `--native`
 * (the package must compile natively) and `--npm-static` (compile the named
 * packages' shipped JavaScript). A mark is honored or refused, never
 * accepted for a name that means nothing: the build stops with SC8006, as
 * it does for `--node-island` (policy.ts readNodeIslandMark, executable/
 * prepare.ts decideNodeIslands).
 *
 *  - `--native=<name>` decides where one package of this program runs, as
 *    `--node-island=<name>` does, so it has the same rule: the program must
 *    load the package from node_modules.
 *  - `--npm-static=<names>` is a selection: it says how each named package
 *    compiles when the program loads it, and one list serves several entry
 *    modules (a package and the dependencies it may or may not reach). A
 *    name the program does not load selects nothing, and coverage does not
 *    list it as compiled; a name that is installed nowhere the program
 *    could load it from is refused.
 *
 * Only command-line marks are held to this: a project's configuration may
 * list packages for other entries. */
import { dirname, join } from "node:path";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import { trackedFileExists, trackedRealpath } from "../frontend/input-tracker.js";
import { builtinPackageAliasFor, packageShimFor } from "../frontend/package-shims.js";
import { resolveBareModule } from "../frontend/resolve.js";
import { packageNameOfSpecifier } from "../frontend/workspace-registry.js";
import type { SrcLoc } from "../ir/ir.js";
import type { NodeIslandPolicy } from "./policy.js";
import type { NodeIslandScan } from "./scan.js";

export interface PackageMark {
  flag: "--native" | "--npm-static";
  /** The value as written (`pkg`, `pkg...`). */
  value: string;
  /** The package name the build looks for: the value, without the `...`
   * of a dependency closure. A package is the unit both flags act on, so a
   * path inside one (`pkg/lib/index.js`) names no package. */
  name: string;
}

/** The command line's `--native` and `--npm-static` marks, in that order,
 * one per package and flag. `--npm-static=pkg...` names `pkg` (and whatever
 * it depends on, which is not a name the user wrote); `auto` names nothing. */
export function commandLinePackageMarks(
  policy: NodeIslandPolicy,
  npmStatic: readonly string[] | "auto" | undefined,
): PackageMark[] {
  const marks: PackageMark[] = [];
  for (const [name, source] of policy.forcedNative)
    if (source === "cli") marks.push({ flag: "--native", value: name, name });
  if (npmStatic !== undefined && typeof npmStatic !== "string") {
    const seen = new Set<string>();
    for (const value of npmStatic) {
      const name = value.endsWith("...") && value.length > 3 ? value.slice(0, -3) : value;
      if (seen.has(name)) continue;
      seen.add(name);
      marks.push({ flag: "--npm-static", value, name });
    }
  }
  return marks;
}

export interface PackageMarkCheck {
  /** SC8006 for each mark the build refuses. */
  problems: ScrDiagnostic[];
  /** The `--npm-static` names that select nothing in this program: installed
   * for it, and not loaded by it. Nothing of them compiles. */
  unloaded: Set<string>;
}

/** The directory of the package named `name` as Node's lookup from `dir`
 * finds it (node_modules walked upward, the link followed), or null. */
function installedFrom(dir: string, name: string): string | null {
  for (let at = dir; ;) {
    const candidate = join(at, "node_modules", name);
    if (trackedFileExists(join(candidate, "package.json")))
      return trackedRealpath(candidate) ?? candidate;
    const parent = dirname(at);
    if (parent === at) return null;
    at = parent;
  }
}

/** Holds the marks against the program. A mark is matched when the program
 * loads its package: a module of the package is in the program, an import or
 * require names it (a registry implementation or a builtin alias serves some
 * of those), or its compilation was refused; an `import type` loads nothing.
 * A package scriptc compiles from its own implementation, serves as a Node
 * builtin, or compiles from workspace source is compiled natively by its own
 * rule, whether or not the scan finds a module of it, so a mark that names
 * one is left to that rule.
 *
 * An unmatched `--native` mark is refused. An unmatched `--npm-static` name
 * is refused when the package is installed nowhere the program could load
 * it from: not where the entry module, a package the program loads, or
 * another named package found this way would resolve it. */
export function checkPackageMarks(
  entryPath: string,
  marks: readonly PackageMark[],
  scan: NodeIslandScan,
): PackageMarkCheck {
  const problems: ScrDiagnostic[] = [];
  const unloaded = new Set<string>();
  if (marks.length === 0) return { problems, unloaded };
  const loaded = new Set<string>();
  // Every directory a package of the program is installed in: one package
  // name can be loaded from several installations, each with dependencies
  // of its own.
  const dirs = [dirname(entryPath)];
  const known = new Set(dirs);
  const lookFrom = (dir: string): void => {
    if (known.has(dir)) return;
    known.add(dir);
    dirs.push(dir);
  };
  for (const module of scan.modules) {
    if (module.origin !== "npm" || module.packageName === null) continue;
    loaded.add(module.packageName);
    if (module.packageDir !== null) lookFrom(module.packageDir);
  }
  for (const edge of scan.edges) loaded.add(edge.to);
  for (const refusal of scan.refusals) loaded.add(refusal.package);
  const unmatched = marks.filter(
    (mark) =>
      !loaded.has(mark.name) &&
      packageShimFor(entryPath, mark.name) === null &&
      builtinPackageAliasFor(entryPath, mark.name) === null &&
      resolveBareModule(entryPath, mark.name)?.workspaceDir === undefined,
  );
  // The selection's names that are installed for the program: found from a
  // directory already known, which then is one more place to look from (a
  // dependency of a named dependency).
  const pending = new Set(
    unmatched.filter((mark) => mark.flag === "--npm-static").map((mark) => mark.name),
  );
  for (let found = true; found && pending.size > 0;) {
    found = false;
    for (const name of [...pending]) {
      for (let i = 0; i < dirs.length; i++) {
        const dir = installedFrom(dirs[i]!, name);
        if (dir === null) continue;
        pending.delete(name);
        unloaded.add(name);
        lookFrom(dir);
        found = true;
        break;
      }
    }
  }
  const loc: SrcLoc = { file: entryPath, start: 0, end: 0 };
  for (const mark of unmatched) {
    // An installed name is an empty selection for --npm-static only: a
    // --native mark of the same name is still a mark on a package the
    // program does not load.
    if (mark.flag === "--npm-static" && unloaded.has(mark.name)) continue;
    // A path inside a package the program loads: the package is the unit.
    const owner = packageNameOfSpecifier(mark.name);
    const inside = owner !== mark.name && loaded.has(owner);
    problems.push({
      code: "SC8006",
      message:
        mark.flag === "--native"
          ? `--native=${mark.value} names no package this program loads from node_modules`
          : `--npm-static=${mark.value} names no package this program loads or could load from node_modules`,
      loc,
      hint: inside
        ? `the flag names a package, not a module of one: write ${mark.flag}=${owner}`
        : mark.flag === "--native"
          ? "a package compiles natively when the program imports a module of it (an `import type` loads nothing); drop the flag, or import the package"
          : "no package of this name is installed where the program, or a package it loads, would find it; check the spelling, or install the package",
    });
  }
  return { problems, unloaded };
}
