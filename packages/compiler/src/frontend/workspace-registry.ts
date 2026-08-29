/* A bare specifier can resolve through node_modules to a symlink whose real
 * location lies outside every node_modules directory — the workspace link
 * every monorepo tool installs for internal packages (pnpm, npm, yarn, and
 * bun workspaces all do). Node resolves and runs such a package exactly
 * like any installed one, and so does scriptc — but the resolved files'
 * REALPATHS carry no node_modules segment, so every path-keyed package
 * attribution (which package declared this symbol, which package does this
 * diagnostic belong to, is this file inside the --npm-static opt-in) needs
 * this registry: real package directory → package name, filled by the
 * resolver as workspace links are discovered and reset per load. */

import { trackedRealpath } from "./input-tracker.js";

const workspacePackageDirs = new Map<string, string>();

export function registerWorkspacePackage(name: string, realDir: string): void {
  workspacePackageDirs.set(realDir.split("\\").join("/"), name);
}

export function clearWorkspacePackages(): void {
  workspacePackageDirs.clear();
}

/** True when `name` is a registered workspace package — the NAME-keyed
 * twin of workspacePackageOfPath, for call sites that hold a bare import
 * specifier instead of a file path (a workspace member installed by COPY
 * has no out-of-node_modules files to match, but its name registered all
 * the same). */
export function isWorkspacePackageName(name: string): boolean {
  for (const n of workspacePackageDirs.values()) {
    if (n === name) return true;
  }
  return false;
}

/** The registered workspace package a path lies inside, or null. */
export function workspacePackageOfPath(path: string): string | null {
  const norm = path.split("\\").join("/");
  for (const [dir, name] of workspacePackageDirs) {
    if (norm === dir || (norm.startsWith(dir) && norm[dir.length] === "/")) return name;
  }
  return null;
}

/** Node's relative-specifier family: './x', '../x', and the bare '.' /
 * '..' directory forms (path resolution treats them identically —
 * real CLIs import `from '..'` for a parent directory's index).
 * Anything else is a package, builtin, or package.json-mediated
 * specifier. ('...' and friends are legal PACKAGE names — only the exact
 * dot forms are relative.) */
export function isRelativeSpecifier(spec: string): boolean {
  return spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../");
}

/** Package-name prefix of a bare specifier: "@scope/pkg/sub" becomes
 * "@scope/pkg", while "pkg/sub" becomes "pkg". */
export function packageNameOfSpecifier(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Package name from a path under node_modules — the LAST node_modules
 * segment (nested installs blame the innermost package), scoped-aware:
 * ".../node_modules/@scope/pkg/dist/x.d.ts" → "@scope/pkg". Paths with no
 * node_modules segment answer their registered workspace package (the
 * realpath'd home of a symlinked workspace install), else null.
 * pnpm symlink farming: dependencies live next to the REAL location
 * (node_modules/.pnpm/pkg@ver/node_modules/pkg) — the walk must start
 * from the realpath so the store's isolated node_modules is visible,
 * while workspace symlinks escape node_modules entirely and fall back
 * to the registry. */
export function npmPackageNameOf(file: string): string | null {
  // Prefer the realpath for pnpm virtual-store and workspace symlinks;
  // fall back to the logical path when realpath is unavailable (file
  // not yet on disk during probe) so both install shapes classify.
  const candidates = (() => {
    const real = trackedRealpath(file);
    if (real !== null) {
      const normReal = real.split("\\").join("/");
      const normFile = file.split("\\").join("/");
      return normReal !== normFile ? [normReal, normFile] : [normFile];
    }
    return [file.split("\\").join("/")];
  })();
  for (const cand of candidates) {
    const parts = cand.split("/");
    const i = parts.lastIndexOf("node_modules");
    if (i >= 0 && i + 1 < parts.length) {
      const first = parts[i + 1]!;
      // pnpm's content-addressable store uses `.../.pnpm/<name@ver>/node_modules/<name>`
      // — the intermediate `.pnpm` directory is not a package.
      if (first === ".pnpm") continue;
      if (first.startsWith("@")) {
        const second = parts[i + 2];
        return second ? `${first}/${second}` : first;
      }
      return first;
    }
    const ws = workspacePackageOfPath(cand);
    if (ws !== null) return ws;
  }
  return workspacePackageOfPath(file.split("\\").join("/"));
}
