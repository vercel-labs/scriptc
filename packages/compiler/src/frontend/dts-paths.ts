import { createRequire } from "node:module";
import { npmPackageNameOf } from "./workspace-registry.js";

const require = createRequire(import.meta.url);

/** tsgo uses slash-normalized file names on Windows (for SourceFile names
 * and virtual-FS callbacks), while Node's path APIs use backslashes there.
 * POSIX backslashes stay literal: they are valid filename characters. */
export function tsgoPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? path.replaceAll("\\", "/") : path;
}

/** Path of the shipped ambient declarations — the always-shipped CORE
 * (comptime/__island_eval, setTimeout). Part of EVERY program scriptc
 * builds, the project-world preflight program included. */
export function ambientDtsPath(): string {
  return tsgoPath(require.resolve("@scriptc/compiler/scriptc.d.ts"));
}

/** Path of the shipped divergence/precision OVERRIDES (JSON.parse():
 * unknown, pop(): T, the Promise executor shape, ...). Part of the LOWERING
 * program only — preflight's project-world second chance builds without it,
 * so a project that typechecks under its own tsc never fails preflight over
 * an override-manufactured error (checkPreflight). */
export function overridesDtsPath(): string {
  return tsgoPath(require.resolve("@scriptc/compiler/scriptc-overrides.d.ts"));
}

/** Path of the shipped FALLBACK declarations (console, process, node:fs) —
 * part of the program only when the target project has no @types/node.
 * With @types/node, the project's real Node types stand in and this file
 * stands down (its declaration forms would collide). */
export function fallbackDtsPath(): string {
  return tsgoPath(require.resolve("@scriptc/compiler/scriptc-node-fallback.d.ts"));
}

/** True for files belonging to the adopted Node type surface: the
 * @types/node package itself and undici-types (its dependency — the
 * web-platform globals: fetch/Response/AbortSignal/ReadableStream/...).
 * The provenance half of the lowering tables' recognition when the
 * fallback declarations stand down, and of the SC2020-family fence for
 * everything else those packages declare. */
export function isNodeTypesPath(file: string): boolean {
  const pkg = npmPackageNameOf(file);
  return pkg === "@types/node" || pkg === "undici-types";
}
