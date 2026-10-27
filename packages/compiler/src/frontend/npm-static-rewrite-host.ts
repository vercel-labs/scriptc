/** Filesystem resolution for CommonJS rewrites with an explicitly owned parser. */
import { dirname, join, resolve as resolvePath } from "node:path";
import { cjsLexedExportsOfFile, cjsVisibleNames } from "./cjs-syntax.js";
import type { Ts7SourceParser } from "./ts7/source-parser.js";
import {
  isVirtualSource,
  trackedDirectoryExists,
  trackedFileExists,
  trackedReadFile,
} from "./input-tracker.js";
import { resolveExports } from "./resolve.js";
import { packageNameOfSpecifier } from "./workspace-registry.js";
import { isBundlerCjsCandidate, rewriteBundlerCjsSyntax } from "./npm-static-rewrite-syntax.js";
import { lowerBundledEsmInits } from "./npm-static-bundled-esm.js";

const NODE_REQUIRE_CONDITIONS = new Set(["require", "node", "default"]);

/** Node's file-first CJS probes over an ABSOLUTE base (the dist-tree
 * subset: exact, .js/.cjs, /index.js, package.json "main" for
 * directories). */
function resolveCjsBase(base: string): string | null {
  const candidates = [base, `${base}.js`, `${base}.cjs`];
  for (const c of candidates) {
    if (trackedFileExists(c) && /\.(js|cjs)$/.test(c)) return c;
  }
  try {
    if (trackedDirectoryExists(base)) {
      const pkgPath = resolvePath(base, "package.json");
      const pkgText = trackedReadFile(pkgPath);
      if (pkgText !== null) {
        const main = (JSON.parse(pkgText) as { main?: unknown }).main;
        if (typeof main === "string") {
          const m = resolvePath(base, main);
          for (const c of [m, `${m}.js`, `${m}.cjs`, resolvePath(m, "index.js")]) {
            if (trackedFileExists(c) && /\.(js|cjs)$/.test(c)) return c;
          }
        }
      }
      const idx = resolvePath(base, "index.js");
      if (trackedFileExists(idx)) return idx;
    }
  } catch {
    /* unresolved */
  }
  return null;
}

/** Resolves a RELATIVE CJS require target (resolveCjsBase over the
 * importer-anchored path). Bare specifiers answer null — their names ride
 * the spread entry and the program resolver. */
function resolveRelativeCjs(fromFile: string, spec: string): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  return resolveCjsBase(resolvePath(dirname(fromFile), spec));
}

/** Resolves a BARE require target the way Node's CJS resolution would (the
 * __toESM default-shape probe's subset): node_modules/<name> walked up from
 * the requiring file, "exports" honored with the require condition, then
 * main/index. Best-effort — null keeps the caller conservative. */
function resolveBareRequireCjs(fromFile: string, spec: string): string | null {
  if (spec.startsWith("#") || spec.startsWith("node:")) return null;
  const parts = spec.split("/");
  const name = packageNameOfSpecifier(spec);
  const subparts = spec.startsWith("@") ? parts.slice(2) : parts.slice(1);
  const subpath = subparts.length > 0 ? `./${subparts.join("/")}` : ".";
  for (let dir = dirname(fromFile); ;) {
    const pkgDir = join(dir, "node_modules", name);
    try {
      if (trackedDirectoryExists(pkgDir)) {
        const pkgPath = join(pkgDir, "package.json");
        let exports: unknown;
        try {
          const pkgText = trackedReadFile(pkgPath);
          exports =
            pkgText === null ? undefined : (JSON.parse(pkgText) as { exports?: unknown }).exports;
        } catch {
          return null;
        }
        if (exports !== undefined) {
          const target = resolveExports(exports, subpath, NODE_REQUIRE_CONDITIONS);
          return target === null ? null : resolveCjsBase(join(pkgDir, target));
        }
        return resolveCjsBase(subpath === "." ? pkgDir : join(pkgDir, subpath));
      }
    } catch {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Whether `require(spec)` from `fromFile` answers an object whose
 * `__esModule` is TRUTHY at runtime under Node — the branch esbuild's
 * __toESM takes to decide what `default` binds. True for the transpiled-ESM
 * stamps (the lexer-visible `exports.__esModule =` / defineProperty forms,
 * esbuild's own `module.exports = __toCommonJS(…)` where the stamp hides
 * from the lexer inside the helper) and for real ES-module targets
 * (require(esm) marks the namespace for interop); `module.exports =
 * require(…)` forwarding chains follow. False (the CJS answer: `default`
 * IS module.exports) everywhere else, unresolvable targets included —
 * their require throws before `default` matters. */
function requireTargetEsModuleStamped(
  parser: Ts7SourceParser,
  fromFile: string,
  spec: string,
  depth = 0,
): boolean {
  if (depth > 8) return false;
  const file =
    spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")
      ? resolveCjsBase(spec.startsWith("/") ? spec : resolvePath(dirname(fromFile), spec))
      : resolveBareRequireCjs(fromFile, spec);
  if (file === null) return false;
  if (file.endsWith(".mjs")) return true;
  if (file.endsWith(".json")) return false;
  if (file.endsWith(".js")) {
    // the nearest package.json "type" decides the .js format
    for (let dir = dirname(file); ;) {
      const pkgPath = join(dir, "package.json");
      const pkgText = trackedReadFile(pkgPath);
      if (pkgText !== null) {
        try {
          if ((JSON.parse(pkgText) as { type?: unknown }).type === "module") return true;
        } catch {
          /* unreadable — treat as CJS */
        }
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const src = trackedReadFile(file);
  if (src === null) return false;
  try {
    if (cjsLexedExportsOfFile(parser.parse(file, src, "js")).exports.has("__esModule")) return true;
  } catch {
    /* unlexable — keep probing */
  }
  if (/__toCommonJS\d*\(/.test(src)) return true;
  const fwd = /module\.exports\s*=\s*require\(\s*["']([^"']+)["']\s*\)/.exec(src);
  if (fwd !== null) return requireTargetEsModuleStamped(parser, file, fwd[1]!, depth + 1);
  return false;
}

/** The Node-visible named-export set of a star-re-export TARGET file:
 * its recursive lexer-visible names (relative edges only — exactly what
 * the emitted member entries must enumerate). */
function starTargetNames(parser: Ts7SourceParser, file: string): Set<string> {
  try {
    return cjsVisibleNames(
      file,
      (f) => {
        const source = trackedReadFile(f);
        if (source === null) throw new Error(`cannot read ${f}`);
        return cjsLexedExportsOfFile(parser.parse(f, source, "js"));
      },
      (from, spec) => resolveRelativeCjs(from, spec),
    );
  } catch {
    return new Set();
  }
}

export function lowerEsmInitsWithParser(
  parser: Ts7SourceParser,
  source: string,
  filePath: string,
): string | { degrade: string } | null {
  if (!source.includes("__esm")) return null;
  return lowerBundledEsmInits(parser.parse(filePath, source, "js"), filePath, {
    requireTargetEsModuleStamped: (from, spec) => requireTargetEsModuleStamped(parser, from, spec),
  });
}

export function rewriteBundlerCjsWithParser(
  parser: Ts7SourceParser,
  source: string,
  filePath: string,
  liveExportTable?: (filePath: string) => void,
  lexerVisibleNames?: (filePath: string, names: readonly string[]) => void,
): string | { degrade: string } | null {
  if (!isBundlerCjsCandidate(source)) return null;
  return rewriteBundlerCjsSyntax(parser.parse(filePath, source, "js"), filePath, {
    liveExportTable,
    lexerVisibleNames,
    requireOnly: isVirtualSource,
    requireTargetEsModuleStamped: (from, spec) => requireTargetEsModuleStamped(parser, from, spec),
    starTargetNames: (from, spec) => {
      const target = resolveRelativeCjs(from, spec);
      return target === null ? new Set<string>() : starTargetNames(parser, target);
    },
  });
}
