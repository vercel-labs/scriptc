/* The census's enum surface over typescript@7.0.2 (the plain "typescript"
 * dependency — 5.9.3 lives under the "typescript5" alias, islands only; see
 * adapter.ts for the two-world rules). Everything here re-exports
 * SYMBOLICALLY from 7: the two
 * worlds renumbered their enums (SyntaxKind 218/396 keys differ, TypeFlags
 * 64/71, NodeFlags 33/41 — the survey's census), so a numeric constant copied
 * from either world is a silent lie in the other. No numeric values appear in
 * this module.
 *
 * Placement in 7.0.2 (probed): the AST-world enums ship from unstable/ast,
 * the checker-world enums from unstable/sync. ModuleResolutionKind and
 * ModuleDetectionKind are the census/options enums the package does not
 * re-export from any public entry point — they live in dist/enums (the
 * #enums/* internal imports), which the exports map hides from bare-
 * specifier imports but NOT from a direct file require; loadHiddenEnum
 * resolves the package root and requires the enum module by path, so the
 * values are still TypeScript 7's own, never copied numbers. */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export {
  InternalSymbolName,
  ModifierFlags,
  NodeFlags,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  TokenFlags,
} from "typescript/unstable/ast";

export {
  DiagnosticCategory,
  ElementFlags,
  ModuleKind,
  NodeBuilderFlags,
  ObjectFlags,
  SignatureFlags,
  SignatureKind,
  SymbolFlags,
  TypeFlags,
  TypePredicateKind,
} from "typescript/unstable/sync";

const require = createRequire(import.meta.url);

/** Loads one of typescript(7)'s dist/enums modules by file path (the exports
 * map hides them; a path require does not go through it). The enum files are
 * ESM, so this leans on Node's require(esm) — the repo floor is Node 24,
 * where that is always available. */
function loadHiddenEnum<T>(basename: string, key: string): T {
  const packageRoot = dirname(require.resolve("typescript/package.json"));
  const mod = require(join(packageRoot, "dist", "enums", `${basename}.js`)) as Record<string, T>;
  const value = mod[key];
  if (value === undefined) throw new Error(`typescript enum module ${basename} has no export ${key}`);
  return value;
}

/* ModuleResolutionKind: TS7's own runtime object (numeric enum with reverse
 * mapping), loaded from the package's generated enum module. The TYPE side is
 * derived from the value object — member types are plain numbers rather than
 * enum literal types, which is fine for the census's one use (building the
 * moduleResolution compiler option). */
interface ModuleResolutionKindEnum {
  readonly Unknown: number;
  readonly Classic: number;
  readonly Node10: number;
  readonly Node16: number;
  readonly NodeNext: number;
  readonly Bundler: number;
  readonly [key: string | number]: string | number;
}

export const ModuleResolutionKind: ModuleResolutionKindEnum =
  loadHiddenEnum<ModuleResolutionKindEnum>("moduleResolutionKind", "ModuleResolutionKind");
export type ModuleResolutionKind = number;

interface ModuleDetectionKindEnum {
  readonly None: number;
  readonly Auto: number;
  readonly Legacy: number;
  readonly Force: number;
  readonly [key: string | number]: string | number;
}

export const ModuleDetectionKind: ModuleDetectionKindEnum =
  loadHiddenEnum<ModuleDetectionKindEnum>("moduleDetectionKind", "ModuleDetectionKind");
export type ModuleDetectionKind = number;

/* JsxEmit isn't re-exported from unstable/ast or unstable/sync either — same
 * hidden dist/enums placement as ModuleResolutionKind/ModuleDetectionKind
 * above. Worth calling out by name: 7.0.2 renumbers React/ReactNative
 * relative to 5.9.3 (None=0 Preserve=1 ReactNative=2 React=3 ReactJSX=4
 * ReactJSXDev=5, vs 5.9.3's React=2/ReactNative=3) — exactly the silent-lie
 * risk this file's own top comment warns about, so this goes through the
 * same symbolic reverse-mapping as everything else here rather than a
 * hardcoded positional table. */
interface JsxEmitEnum {
  readonly None: number;
  readonly Preserve: number;
  readonly React: number;
  readonly ReactNative: number;
  readonly ReactJSX: number;
  readonly ReactJSXDev: number;
  readonly [key: string | number]: string | number;
}

export const JsxEmit: JsxEmitEnum = loadHiddenEnum<JsxEmitEnum>("jsxEmit", "JsxEmit");
export type JsxEmit = number;

/** Reverse-maps a numeric enum value to its TS7 key name ("ESNext",
 * "Bundler") — the spelling tsgo's tsconfig JSON parser accepts (lowercased
 * by the caller where needed). Symbolic by construction: the name comes from
 * the enum object's own reverse mapping. */
export function enumKeyOf(enumObject: Record<string | number, string | number>, value: number): string | undefined {
  const key = enumObject[value];
  return typeof key === "string" ? key : undefined;
}
