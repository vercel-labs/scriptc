/* The unit store (M0): `resolveBuildCacheRoot()/units-v2/<key>/` holding
 * `summary.json`, `meta.json` and, from M1 on, `objects/*.o`.
 *
 * `units-v1` belongs to the incremental lowering store (unit-reuse.ts), so
 * the separate-compilation family gets its own directory. Writes install
 * through a private sibling name and a rename (backend/build-cache.ts), so a
 * reader sees a whole file or nothing; every read failure is a miss.
 *
 * The shared cache's LRU sweep (pruneCache) walks the whole root, so this
 * family is covered with the others; a build that stages an entry adds its
 * paths to the protected set it hands the sweeper (protectCachedArtifact).
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { privateSiblingPath, protectCachedArtifact } from "../backend/build-cache.js";
import { resolveBuildCacheRoot } from "../backend/cache-root.js";
import type { UnitStoreMeta } from "./types.js";

export const UNITS_CACHE_FAMILY = "units-v2";

/** The unit store's root for this process, or null when the build has no
 * shared cache (`SCRIPTC_NO_CACHE`, an empty SCRIPTC_CACHE_DIR). */
export function unitsStoreRoot(): string | null {
  const root = resolveBuildCacheRoot();
  return root === null ? null : join(root, UNITS_CACHE_FAMILY);
}

/** One key's directory. */
export function unitEntryDirectory(root: string, key: string): string {
  return join(root, key);
}

/** The paths one entry may write, for the sweeper's protected set. `ir.bin`
 * is absent for an entry that stored no IR; protecting an absent path is
 * harmless. */
export function unitEntryPaths(root: string, key: string): string[] {
  const directory = unitEntryDirectory(root, key);
  return [join(directory, "summary.json"), join(directory, "meta.json"), join(directory, "ir.bin")];
}

/** Add a staged entry to the executing build's protected set. */
export function protectUnitEntry(root: string, key: string, protectedPaths: Set<string>): void {
  for (const path of unitEntryPaths(root, key)) protectCachedArtifact(protectedPaths, path);
}

/** A stored entry, or null on any failure. */
export function readUnitEntry(
  root: string,
  key: string,
): { summary: string; meta: UnitStoreMeta | null } | null {
  const directory = unitEntryDirectory(root, key);
  try {
    const summary = readFileSync(join(directory, "summary.json"), "utf8");
    let meta: UnitStoreMeta | null = null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(directory, "meta.json"), "utf8"));
      meta =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as UnitStoreMeta)
          : null;
    } catch {
      meta = null;
    }
    return { summary, meta };
  } catch {
    return null;
  }
}

/** Install one entry atomically. A write failure is the caller's to ignore:
 * the store is an optimization and the unit's summary was already computed. */
export function writeUnitEntry(
  root: string,
  key: string,
  summary: string,
  meta: UnitStoreMeta,
  ir?: Buffer,
): void {
  const directory = unitEntryDirectory(root, key);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeAtomically(join(directory, "summary.json"), summary);
  writeAtomically(join(directory, "meta.json"), JSON.stringify(meta));
  if (ir !== undefined) writeBytesAtomically(join(directory, "ir.bin"), ir);
}

/** A stored entry's IR, or null on any failure. The caller checks its
 * digest against the metadata's: a truncated or foreign file is a miss. */
export function readUnitIr(root: string, key: string): Buffer | null {
  try {
    return readFileSync(join(unitEntryDirectory(root, key), "ir.bin"));
  } catch {
    return null;
  }
}

/** Write through a private sibling and rename; remove the sibling on
 * failure. */
function writeAtomically(destination: string, text: string): void {
  writeBytesAtomically(destination, Buffer.from(text, "utf8"));
}

/** As writeAtomically, for bytes. */
function writeBytesAtomically(destination: string, bytes: Buffer): void {
  const temporary = privateSiblingPath(destination, "unit");
  try {
    writeFileSync(temporary, bytes, { mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}
