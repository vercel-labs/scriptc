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
import { readProjectConfig } from "../project-config.js";

export const SCRIPTC_CONDITION = "scriptc";

/* A project can give an installed package the scriptc branch it does not
 * publish: `"scriptc": { "packages": { "rxjs": { "conditions": ["es2015"] } } }`
 * in the entry's nearest package.json. In each of that package's condition
 * objects without a scriptc entry, the first listed condition it has
 * supplies the scriptc target (preferredConditionsManifest), so every world
 * scriptc resolves selects that branch before node, import, require and
 * default. Node islands run the package as Node resolves it. */

/** The configured conditions, by package name. */
let preferredConditions: ReadonlyMap<string, readonly string[]> = new Map();

/** Reads the `conditions` of the entry's `scriptc.packages` settings.
 * Called once per program load, before any package.json is resolved. */
export function configurePreferredConditions(entryPath: string): void {
  const next = new Map<string, readonly string[]>();
  for (const [name, setting] of readProjectConfig(entryPath).packages) {
    if (setting.conditions.length > 0) next.set(name, setting.conditions);
  }
  const same =
    next.size === preferredConditions.size &&
    [...next].every(
      ([name, list]) => preferredConditions.get(name)?.join("\0") === list.join("\0"),
    );
  if (same) return;
  preferredConditions = next;
  servedManifests.clear();
}

/** `value` with a scriptc entry added to each condition object that has
 * one of `conditions` and no scriptc entry of its own, or the value itself
 * when none changes. */
function withPreferred(value: unknown, conditions: readonly string[]): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const items = value.map((item) => withPreferred(item, conditions));
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  const children: [string, unknown][] = entries.map(([key, child]) => [
    key,
    withPreferred(child, conditions),
  ]);
  const changed = children.some(([, child], index) => child !== entries[index]![1]);
  const isConditions =
    entries.length > 0 &&
    !entries.some(([key]) => key.startsWith(".") || key.startsWith("#")) &&
    !Object.prototype.hasOwnProperty.call(record, SCRIPTC_CONDITION);
  const preferred = isConditions
    ? conditions.find((condition) => Object.prototype.hasOwnProperty.call(record, condition))
    : undefined;
  if (preferred === undefined) return changed ? Object.fromEntries(children) : value;
  const target = children.find(([key]) => key === preferred)![1];
  return Object.fromEntries([...children, [SCRIPTC_CONDITION, target]]);
}

/** Adds the scriptc entries the project configures for the package `pkg`
 * names (its "exports" and "imports"), in place. True when one was added. */
export function applyPreferredConditions(pkg: Record<string, unknown>): boolean {
  if (preferredConditions.size === 0 || typeof pkg["name"] !== "string") return false;
  const conditions = preferredConditions.get(pkg["name"]);
  if (conditions === undefined) return false;
  let changed = false;
  for (const field of ["exports", "imports"]) {
    const value = pkg[field];
    if (value === undefined) continue;
    const next = withPreferred(value, conditions);
    if (next === value) continue;
    pkg[field] = next;
    changed = true;
  }
  return changed;
}

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
  // A cheap probe: a manifest without the key anywhere is served as written,
  // unless the project configures conditions for some package.
  if (preferredConditions.size === 0 && !text.includes(`"${SCRIPTC_CONDITION}"`)) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const pkg = doc as Record<string, unknown>;
  let changed = applyPreferredConditions(pkg);
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
