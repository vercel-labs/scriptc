/* scriptc's own package condition. A package can publish the code scriptc
 * compiles under a `scriptc` key of its "exports" or "imports" condition
 * objects; every world scriptc resolves selects that branch before node,
 * import, require and default, whatever order the object lists its keys in.
 * In a world that matches types, a types entry leads the scriptc branch, so
 * the package's declarations type the code that branch supplies.
 *
 * resolve.ts applies the order itself. The checker matches only its own
 * bundler conditions in key order, so the package.json text the checker's
 * host serves carries the same answer (scriptcConditionManifest): the
 * scriptc target is published under the keys the checker matches, ahead of
 * every key but types. Both worlds then answer one file for the import, a
 * package self-reference and a package import alike. */

export const SCRIPTC_CONDITION = "scriptc";

/** A condition object's entries with the scriptc entry first, preceded by
 * the types entry in a world that matches types. Unchanged without a
 * scriptc entry. */
export function scriptcConditionFirst(
  entries: [string, unknown][],
  matchesTypes: boolean,
): [string, unknown][] {
  const scriptc = entries.find(([key]) => key === SCRIPTC_CONDITION);
  if (scriptc === undefined) return entries;
  const types = matchesTypes ? entries.find(([key]) => key === "types") : undefined;
  const lead = types === undefined ? [scriptc] : [types, scriptc];
  return [...lead, ...entries.filter((entry) => !lead.includes(entry))];
}

/** The keys the checker matches for a package import (its bundler
 * conditions, and require for a require call), each answered by the scriptc
 * target in the served manifest. */
const CHECKER_KEYS = ["import", "require", "default"];

/** `value` with each condition object that has a scriptc entry reordered
 * for the checker, or the value itself when none has one. */
function forChecker(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const items = value.map(forChecker);
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  const children: [string, unknown][] = entries.map(([key, child]) => [key, forChecker(child)]);
  const changed = children.some(([, child], index) => child !== entries[index]![1]);
  const isConditions =
    !entries.some(([key]) => key.startsWith(".") || key.startsWith("#")) &&
    Object.prototype.hasOwnProperty.call(record, SCRIPTC_CONDITION);
  if (!isConditions) return changed ? Object.fromEntries(children) : value;
  const ordered = scriptcConditionFirst(children, true);
  const out: [string, unknown][] = [];
  const seen = new Set<string>();
  const add = (key: string, child: unknown): void => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push([key, child]);
  };
  for (const [key, child] of ordered) {
    add(key, child);
    if (key === SCRIPTC_CONDITION) for (const checkerKey of CHECKER_KEYS) add(checkerKey, child);
  }
  return Object.fromEntries(out);
}

/** The package.json text the checker's host serves for `text`: its
 * "exports" and "imports" condition objects with the scriptc branch first,
 * or null when no condition object names one (the text is served as
 * written). Malformed documents are served as written too, so resolution
 * reports them as it always does. */
export function scriptcConditionManifest(text: string): string | null {
  // A cheap probe: a manifest without the key anywhere is served as written.
  if (!text.includes(`"${SCRIPTC_CONDITION}"`)) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const pkg = doc as Record<string, unknown>;
  let changed = false;
  for (const field of ["exports", "imports"]) {
    const value = pkg[field];
    if (value === undefined) continue;
    const served = forChecker(value);
    if (served === value) continue;
    pkg[field] = served;
    changed = true;
  }
  return changed ? JSON.stringify(pkg) : null;
}

/** The served text of each manifest, by path and the text it read: the
 * checker's host asks for one manifest many times while it resolves a
 * load's imports. */
const servedManifests = new Map<string, { source: string; served: string | null }>();

/** scriptcConditionManifest for the package.json at `path` whose text is
 * `source`, or null for any other file. */
export function scriptcConditionManifestAt(path: string, source: string): string | null {
  if (!path.endsWith("/package.json") && !path.endsWith("\\package.json")) return null;
  const hit = servedManifests.get(path);
  if (hit !== undefined && hit.source === source) return hit.served;
  const served = scriptcConditionManifest(source);
  servedManifests.set(path, { source, served });
  return served;
}
