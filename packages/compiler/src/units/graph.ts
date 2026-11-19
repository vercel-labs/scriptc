/* The unit graph (M0): group the loaded program's implementation files by
 * package, draw the program's resolved module edges between the groups, merge
 * each strongly connected component, and order the result dependencies
 * first.
 *
 * Pure and deterministic: the same program gives the same graph. No absolute
 * path leaves this module except as a lookup key inside the input records;
 * unit ids, file lists and dependency lists are package-relative names. */

import { createHash } from "node:crypto";
import type { UnitGraph, UnitNode, UnitObservationInput } from "./types.js";

/** A unit before SCC merging. */
interface Provisional {
  id: string;
  name: string;
  version: string;
  app: boolean;
  /** Absolute file paths. */
  files: string[];
  /** Package-relative paths, parallel to `files`. */
  relative: Map<string, string>;
  dependencies: Set<string>;
}

/** A short content-derived suffix for a unit id, for spellings that would
 * otherwise be unbounded (a second copy of a version, a merged SCC). */
function suffixOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** The id every copy of `name@version` starts from. */
function baseId(name: string, version: string): string {
  return version === "" ? name : `${name}@${version}`;
}

/** Groups the files into units, drawing dependencies from the resolved
 * edges. */
function provisionalUnits(input: UnitObservationInput): Map<string, Provisional> {
  const units = new Map<string, Provisional>();
  const entryPackage = input.files.find((file) => file.file === input.entry);
  const appRoot = entryPackage?.packageRoot ?? null;
  // Every root of one `name@version`; the first NON-APP copy keeps the plain
  // id and later copies append a root-derived suffix, so two installed
  // copies of one version stay distinct. The app's own copy never takes the
  // plain id when a dependency shares its name@version: the app unit's id
  // may vary with its directory (keys are never shared for it), while a
  // dependency's must not just because the app sat in another directory.
  const rootsByName = new Map<string, string[]>();
  for (const file of input.files) {
    if (file.packageName === null || file.packageRoot === null) continue;
    const base = baseId(file.packageName, file.packageVersion ?? "");
    const roots = rootsByName.get(base) ?? [];
    if (!roots.includes(file.packageRoot)) roots.push(file.packageRoot);
    rootsByName.set(base, roots);
  }
  const idOfRoot = new Map<string, string>();
  for (const [base, roots] of rootsByName) {
    roots.sort();
    const nonApp = roots.filter((root) => root !== appRoot);
    const ordered =
      nonApp.length > 0
        ? [...nonApp, ...(appRoot !== null && roots.includes(appRoot) ? [appRoot] : [])]
        : roots;
    for (let index = 0; index < ordered.length; index++) {
      const root = ordered[index]!;
      idOfRoot.set(root, index === 0 ? base : `${base}#${suffixOf(root)}`);
    }
  }
  const appUnitId = ((): string => {
    if (entryPackage !== undefined && entryPackage.packageName !== null)
      return idOfRoot.get(entryPackage.packageRoot!)!;
    return "app";
  })();
  const unitOfFile = new Map<string, string>();
  for (const file of input.files) {
    const id =
      file.packageName !== null && file.packageRoot !== null
        ? idOfRoot.get(file.packageRoot)!
        : appUnitId;
    unitOfFile.set(file.file, id);
    let unit = units.get(id);
    if (unit === undefined) {
      unit = {
        id,
        name: file.packageName ?? "app",
        version: file.packageName === null ? "" : (file.packageVersion ?? ""),
        app: id === appUnitId,
        files: [],
        relative: new Map(),
        dependencies: new Set(),
      };
      units.set(id, unit);
    }
    unit.files.push(file.file);
    unit.relative.set(file.file, file.relative);
  }
  for (const edge of input.edges) {
    const from = unitOfFile.get(edge.from);
    const to = unitOfFile.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    units.get(from)?.dependencies.add(to);
  }
  return units;
}

/** One strongly connected component. */
interface Component {
  id: string;
  members: string[];
  files: string[];
  dependencies: Set<string>;
  app: boolean;
  name: string;
  version: string;
}

/** Tarjan's algorithm over the provisional units, in sorted id order so the
 * components are a function of the graph alone. */
function components(units: Map<string, Provisional>): Component[] {
  const ids = [...units.keys()].sort();
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  const strongConnect = (id: string): void => {
    index.set(id, counter);
    low.set(id, counter);
    counter++;
    stack.push(id);
    onStack.add(id);
    const deps = Array.from(units.get(id)?.dependencies ?? new Set<string>()).sort();
    for (const dep of deps) {
      if (!units.has(dep)) continue;
      if (!index.has(dep)) {
        strongConnect(dep);
        low.set(id, Math.min(low.get(id)!, low.get(dep)!));
      } else if (onStack.has(dep)) {
        low.set(id, Math.min(low.get(id)!, index.get(dep)!));
      }
    }
    if (low.get(id) === index.get(id)) {
      const component: string[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === id) break;
      }
      found.push(component.sort());
    }
  };
  for (const id of ids) if (!index.has(id)) strongConnect(id);
  return found.map((members) => {
    if (members.length === 1) {
      const unit = units.get(members[0]!)!;
      return {
        id: unit.id,
        members,
        files: [...unit.files],
        dependencies: new Set(unit.dependencies),
        app: unit.app,
        name: unit.name,
        version: unit.version,
      };
    }
    const files: string[] = [];
    const dependencies = new Set<string>();
    let app = false;
    for (const member of members) {
      const unit = units.get(member)!;
      files.push(...unit.files);
      app ||= unit.app;
      for (const dep of unit.dependencies) if (!members.includes(dep)) dependencies.add(dep);
    }
    const joined = members.join("+");
    return {
      // A merged SCC's id keeps its members' ids, bounded in length: the
      // summary and meta do not grow with the chain.
      id: joined.length <= 160 ? joined : `merged:${suffixOf(joined)}`,
      members,
      files,
      dependencies,
      app,
      name: `merged:${members.length}`,
      version: "",
    };
  });
}

/** Dependencies first; ties by id. */
function topological(components: readonly Component[]): Component[] {
  const byId = new Map(components.map((component) => [component.id, component]));
  const ordered: Component[] = [];
  const state = new Map<string, "visiting" | "done">();
  // Iterative depth-first so a long dependency chain cannot exhaust the
  // stack.
  const visit = (start: Component): void => {
    if (state.get(start.id) === "done") return;
    const stack: { component: Component; next: number; deps: string[] }[] = [
      { component: start, next: 0, deps: [...start.dependencies].sort() },
    ];
    state.set(start.id, "visiting");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.next < frame.deps.length) {
        const dep = byId.get(frame.deps[frame.next++]!);
        if (dep === undefined) continue;
        const seen = state.get(dep.id);
        if (seen === "done") continue;
        // The merged components are a DAG, so a "visiting" dependency is a
        // merge bug, not a cycle; treat it as already ordered.
        if (seen === "visiting") continue;
        state.set(dep.id, "visiting");
        stack.push({ component: dep, next: 0, deps: [...dep.dependencies].sort() });
        continue;
      }
      stack.pop();
      state.set(frame.component.id, "done");
      ordered.push(frame.component);
    }
  };
  for (const component of [...components].sort((a, b) => a.id.localeCompare(b.id)))
    visit(component);
  return ordered;
}

/** The unit graph of a loaded program. */
export function buildUnitGraph(input: UnitObservationInput): UnitGraph {
  const units = provisionalUnits(input);
  const merged = components(units);
  // A component's dependencies are the pre-merge ids its members named;
  // resolve them through the component the member merged into.
  const componentOf = new Map<string, string>();
  for (const component of merged)
    for (const member of component.members) componentOf.set(member, component.id);
  for (const component of merged) {
    const resolved = new Set<string>();
    for (const dependency of component.dependencies) {
      const id = componentOf.get(dependency);
      if (id !== undefined && id !== component.id) resolved.add(id);
    }
    component.dependencies = resolved;
  }
  const ordered = topological(merged);
  const relative = new Map<string, string>();
  for (const unit of units.values())
    for (const [file, rel] of unit.relative) relative.set(file, rel);
  const nodes: UnitNode[] = ordered.map((component) => {
    const files = [...new Set(component.files.map((file) => relative.get(file) ?? file))].sort(
      (a, b) => a.localeCompare(b),
    );
    return {
      id: component.id,
      name: component.name,
      version: component.version,
      app: component.app,
      files,
      dependencies: [...component.dependencies].sort((a, b) => a.localeCompare(b)),
      mergedFrom: [...component.members],
    };
  });
  const sccMerges = ordered
    .filter((component) => component.members.length > 1)
    .map((component) => ({ id: component.id, members: [...component.members] }));
  return {
    units: nodes,
    sccMerges,
    stats: {
      files: input.files.length,
      units: nodes.length,
      edges: input.edges.length,
      mergedUnits: merged.filter((component) => component.members.length > 1).length,
    },
  };
}

/** The file's unit id in `graph` (null when the graph does not hold the
 * file). The observer maps lowering facts' file paths to units with it. */
export function unitIdByFile(input: UnitObservationInput, graph: UnitGraph): Map<string, string> {
  // Rebuild the same attribution the graph used, without exposing the
  // provisional types.
  const units = provisionalUnits(input);
  const out = new Map<string, string>();
  for (const unit of units.values()) for (const file of unit.files) out.set(file, unit.id);
  // A merged component answers with the merged id.
  for (const node of graph.units) {
    if (node.mergedFrom.length < 2) continue;
    for (const member of node.mergedFrom) {
      for (const [file, id] of out) if (id === member) out.set(file, node.id);
    }
  }
  return out;
}
