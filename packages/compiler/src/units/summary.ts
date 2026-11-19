/* Summary format v1 (M1-1): one unit's declarations' lowering facts, export
 * names, generic families and the instances the build demanded, class
 * numbering as today's backend assigns it, module init names, runtime
 * features, the program facts' values, and the unit's pins (the functions it
 * defines and its classes' ids).
 *
 * Canonical JSON: sorted keys, no source positions, no absolute paths. The
 * leak report compares one unit's summaries from two apps; M1's consumer
 * lowering reads them. */

import { canonicalJson, type CanonicalValue } from "./canonical.js";
import type {
  UnitClassFact,
  UnitDeclarationFact,
  UnitFactValue,
  UnitGenericClassFact,
  UnitGenericDemand,
  UnitGenericFunctionFact,
  UnitGenericsFact,
  UnitLoweringData,
  UnitNode,
  UnitObservation,
  UnitSummary,
} from "./types.js";

/** A class's preorder id and vtable slots, computed exactly as the LLVM
 * backend's `buildClassGraph` does it (classes in module order, roots and
 * children in that order; a slot only when no ancestor declares the method
 * and some strict descendant redeclares it). */
export function classNumbering(
  classes: readonly { name: string; base?: string; methods?: readonly string[] }[],
): Map<string, { id: number; slots: string[] }> {
  const byName = new Map<
    string,
    {
      name: string;
      base?: string;
      methods: readonly string[];
      children: string[];
    }
  >();
  for (const def of classes) {
    byName.set(def.name, {
      name: def.name,
      ...(def.base === undefined ? {} : { base: def.base }),
      methods: def.methods ?? [],
      children: [],
    });
  }
  for (const def of byName.values()) {
    if (def.base === undefined) continue;
    byName.get(def.base)?.children.push(def.name);
  }
  const out = new Map<string, { id: number; slots: string[] }>();
  let counter = 0;
  const number = (name: string): void => {
    const def = byName.get(name);
    if (def === undefined) return;
    out.set(name, { id: counter++, slots: [] });
    for (const child of def.children) number(child);
  };
  for (const def of byName.values()) if (def.base === undefined) number(def.name);
  const declares = (name: string, method: string): boolean =>
    byName.get(name)?.methods.includes(method) ?? false;
  const declaredBelow = (name: string, method: string): boolean =>
    (byName.get(name)?.children ?? []).some(
      (child) => declares(child, method) || declaredBelow(child, method),
    );
  const collect = (name: string, root: string): void => {
    const def = byName.get(name);
    if (def === undefined) return;
    for (const method of def.methods) {
      let inherited = false;
      let at = def.base;
      while (at !== undefined) {
        if (declares(at, method)) inherited = true;
        at = byName.get(at)?.base;
      }
      if (!inherited && declaredBelow(name, method)) out.get(root)?.slots.push(method);
    }
    for (const child of def.children) collect(child, root);
  };
  for (const def of byName.values()) if (def.base === undefined) collect(def.name, def.name);
  return out;
}

/** The modules one unit contains, as a set for fact filtering. */
function moduleSet(node: UnitNode): Set<string> {
  return new Set(node.files);
}

/** One unit's summary, from the graph node and the observation. */
export function buildUnitSummary(
  node: UnitNode,
  observation: UnitObservation,
  unitsByModule: (module: string) => string | null,
): UnitSummary {
  const modules = moduleSet(node);
  const lowering = observation.lowering;
  const declarations: UnitDeclarationFact[] = lowering.declarations
    .filter((declaration) => modules.has(declaration.module))
    .map((declaration) => ({ ...declaration }))
    .sort(
      (a, b) =>
        a.module.localeCompare(b.module) ||
        a.name.localeCompare(b.name) ||
        a.kind.localeCompare(b.kind),
    );
  const exportsOut: Record<string, readonly string[]> = {};
  for (const entry of lowering.exports) {
    if (modules.has(entry.module)) exportsOut[entry.module] = [...entry.names];
  }
  const generics = summaryGenerics(lowering, modules, unitsByModule);
  const classes: UnitClassFact[] = observation.classes
    .map((entry): UnitClassFact | null => {
      const module = moduleOf(entry.file, observation);
      if (module === null || !modules.has(module)) return null;
      return { module, name: entry.name, id: entry.id, slots: [...entry.slots] };
    })
    .filter((entry): entry is UnitClassFact => entry !== null)
    .sort((a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name));
  const inits = lowering.inits
    .filter((entry) => modules.has(entry.module))
    .map((entry) => ({ ...entry }));
  const pinFunctions = [
    ...new Set(
      observation.pins.functions
        .filter((entry) => modules.has(entry.module))
        .map((entry) => entry.name),
    ),
  ].sort((a, b) => a.localeCompare(b));
  const pinClasses = classes
    .map((entry) => ({ name: entry.name, id: entry.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const facts: Record<string, UnitFactValue> = {};
  for (const name of Object.keys(lowering.facts).sort()) {
    const fact = lowering.facts[name]!;
    facts[name] = { value: fact.value, setByOwnFiles: fact.setByOwnFiles };
  }
  return {
    schema: "scriptc.unit-summary.v1",
    unit: {
      id: node.id,
      name: node.name,
      version: node.version,
      app: node.app,
    },
    files: [...node.files],
    exports: exportsOut,
    declarations,
    generics,
    classes,
    pins: { functions: pinFunctions, classes: pinClasses },
    runtimeFeatures: {
      scope: "program-wide",
      features: observation.runtimeFeatures,
    },
    inits,
    facts,
  };
}

/** The observation's per-file module path for an absolute file. */
function moduleOf(file: string, observation: UnitObservation): string | null {
  return observation.files.find((entry) => entry.file === file)?.relative ?? null;
}

/** The generic families a unit declares, each with the instances the build
 * demanded of it (and which unit demanded them). */
function summaryGenerics(
  lowering: UnitLoweringData,
  modules: Set<string>,
  unitsByModule: (module: string) => string | null,
): UnitGenericsFact {
  const demands = new Map<string, UnitGenericDemand[]>();
  for (const demand of lowering.generics.demands) {
    const list = demands.get(`${demand.kind}\0${demand.generic}`) ?? [];
    list.push(demand);
    demands.set(`${demand.kind}\0${demand.generic}`, list);
  }
  const demandedOf = (
    kind: "function" | "class",
    qualified: string,
  ): { instance: string; by: string | null; byModule: string | null }[] => {
    const list = demands.get(`${kind}\0${qualified}`) ?? [];
    const seen = new Set<string>();
    const out: { instance: string; by: string | null; byModule: string | null }[] = [];
    for (const demand of list) {
      const by = demand.ownerModule === null ? null : unitsByModule(demand.ownerModule);
      const key = `${demand.instance}\0${by ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ instance: demand.instance, by, byModule: demand.ownerModule });
    }
    return out.sort(
      (a, b) => a.instance.localeCompare(b.instance) || (a.by ?? "").localeCompare(b.by ?? ""),
    );
  };
  const functions: UnitGenericFunctionFact[] = lowering.generics.functions
    .filter((declaration) => modules.has(declaration.module))
    .map((declaration) => ({
      module: declaration.module,
      name: declaration.name,
      qualified: declaration.qualified,
      demanded: demandedOf("function", declaration.qualified),
    }))
    .sort((a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name));
  const classes: UnitGenericClassFact[] = lowering.generics.classes
    .filter((declaration) => modules.has(declaration.module))
    .map((declaration) => ({
      module: declaration.module,
      name: declaration.name,
      qualified: declaration.qualified,
      demanded: demandedOf("class", declaration.qualified),
    }))
    .sort((a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name));
  return { functions, classes };
}

/** A sorted-key map of string lists, as canonical JSON data. */
function exportValue(exports: Record<string, readonly string[]>): {
  [key: string]: CanonicalValue;
} {
  const out: { [key: string]: CanonicalValue } = {};
  for (const key of Object.keys(exports).sort()) out[key] = [...(exports[key] ?? [])];
  return out;
}

/** A sorted-key map of runtime feature flags. */
function featureValue(features: Readonly<Record<string, boolean>>): {
  [key: string]: CanonicalValue;
} {
  const out: { [key: string]: CanonicalValue } = {};
  for (const key of Object.keys(features).sort()) out[key] = features[key] === true;
  return out;
}

/** A sorted-key map of fact values. */
function factValue(facts: Record<string, UnitFactValue>): { [key: string]: CanonicalValue } {
  const out: { [key: string]: CanonicalValue } = {};
  for (const key of Object.keys(facts).sort()) {
    const fact = facts[key];
    if (fact === undefined) continue;
    out[key] = { value: fact.value, setByOwnFiles: fact.setByOwnFiles };
  }
  return out;
}

/** The canonical text of a summary. The value is built field by field (rather
 * than cast) so the compiler's own build lowers concrete data, never a
 * checked-dynamic object. */
export function summaryText(summary: UnitSummary): string {
  const value: CanonicalValue = {
    schema: summary.schema,
    unit: {
      id: summary.unit.id,
      name: summary.unit.name,
      version: summary.unit.version,
      app: summary.unit.app,
    },
    files: [...summary.files],
    exports: exportValue(summary.exports),
    declarations: summary.declarations.map((declaration) => ({
      module: declaration.module,
      name: declaration.name,
      kind: declaration.kind,
      facts: declaration.facts,
    })),
    generics: {
      functions: summary.generics.functions.map((declaration) => ({
        module: declaration.module,
        name: declaration.name,
        qualified: declaration.qualified,
        demanded: declaration.demanded.map((demand) => ({
          instance: demand.instance,
          by: demand.by,
          byModule: demand.byModule,
        })),
      })),
      classes: summary.generics.classes.map((declaration) => ({
        module: declaration.module,
        name: declaration.name,
        qualified: declaration.qualified,
        demanded: declaration.demanded.map((demand) => ({
          instance: demand.instance,
          by: demand.by,
          byModule: demand.byModule,
        })),
      })),
    },
    classes: summary.classes.map((entry) => ({
      module: entry.module,
      name: entry.name,
      id: entry.id,
      slots: [...entry.slots],
    })),
    pins: {
      functions: [...summary.pins.functions],
      classes: summary.pins.classes.map((entry) => ({ name: entry.name, id: entry.id })),
    },
    runtimeFeatures: {
      scope: "program-wide",
      features: featureValue(summary.runtimeFeatures.features),
    },
    inits: summary.inits.map((entry) => ({ module: entry.module, name: entry.name })),
    facts: factValue(summary.facts),
  };
  return canonicalJson(value);
}
