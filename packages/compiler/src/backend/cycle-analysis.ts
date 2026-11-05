import type { DynamicFieldStores } from "../ir/int32-slots.js";
import type { IrModule, IrType } from "../ir/ir.js";
import {
  DYN,
  DYN_CLASS_PROPERTIES,
  funcOf,
  mapOf,
  RUNTIME_EMITTER_CLASS,
  RUNTIME_EVENT_CLASS,
  RUNTIME_EVENT_TARGET_CLASS,
  STRING,
  VOID,
} from "../ir/ir.js";
import { type CycleMutability, computeCycleMutability, fieldKey } from "./cycle-mutability.js";

/** Cycle capability for native code generation.
 * Nodes are shape units and unions; edges are the references their fields
 * and arms can hold (collections flattened into their element, key and
 * value types). Closures, checked values, class values, caught values and
 * promises are INTRINSIC: they can reach anything, so a unit holding one is
 * on a potential cycle. Strings never are.
 *
 * An edge is IMMUTABLE when it can only be stored while its owner is still
 * under construction (cycle-mutability.ts derives this from the IR): such an
 * object can only point to objects that existed before it, so a heap cycle
 * made only of immutable edges is impossible. Union arms are immutable (the
 * boxes are), and any edge through an array, Map, or Set is mutable because
 * the container's contents are. A strongly connected component is
 * cycle-capable iff it contains an intrinsic unit or a mutable internal
 * edge; a unit or union is traced iff it can reach a cycle-capable
 * component. With every edge mutable this is exactly the earlier greatest
 * fixpoint: traced iff the unit reaches a cycle or an intrinsic reference.
 *
 * A HIERARCHY is one unit of capability (a base-typed slot can hold any
 * subclass and retain touches the cycle header, so header presence must be
 * uniform across an extends tree): a unit is cycle-capable iff ANY member
 * is — every backend uses the same grouping. */
export function computeTraced(
  mod: IrModule,
  stores?: DynamicFieldStores,
  /** computeCycleMutability's answer for this module, when the caller has it. */
  precomputed?: CycleMutability,
): { shapes: Set<string>; unions: Set<string> } {
  const { shapes, unions } = analyzeCycles(mod, false, stores, precomputed);
  return { shapes, unions };
}

/** Values that can reference any object. */
export type IntrinsicKind = "func" | "dyn" | "jsval" | "classval" | "promise" | "caught";

/** Why an edge of the cycle graph exists (explanations only). */
export type CycleEdgeLabel =
  /** A field (or union arm) of the owning shape. `mutable` edges can be
   * stored after the owner's construction; `via` names the container
   * (`array`, `map`, `set`) the reference sits in, whose contents change. */
  | { kind: "field"; field: string; mutable: boolean; via?: "array" | "map" | "set" }
  /** A union arm. */
  | { kind: "arm" }
  /** A slot of a class type can hold the class itself or a subclass. */
  | { kind: "subclass"; className: string };

/** One step of a cycle explanation: from a unit (`object:<class>`,
 * `record:<id>`, `union:<id>`, or `subtree:<class>` for a slot that can
 * hold any class in a subtree) through an edge. */
export interface CycleStep {
  from: string;
  label: CycleEdgeLabel;
}

export type CycleExplanation =
  /** A cycle through at least one mutable edge: the steps lead from the
   * explained unit back to it. */
  | { kind: "cycle"; steps: CycleStep[] }
  /** The unit reaches a field that holds a value able to reference any
   * object (a function, a dynamic or caught value, a class value, a
   * promise), so it can lie on a cycle through that value. */
  | {
      kind: "intrinsic";
      steps: CycleStep[];
      owner: string;
      field: string;
      holds: IntrinsicKind;
    }
  /** Headers are uniform per class hierarchy: the explained class is
   * traced because another member of its hierarchy is. */
  | { kind: "hierarchy"; member: string; because: CycleExplanation };

/** Why computeTraced traces a shape (`object:<class>` or `record:<id>`) or
 * union (`union:<id>`); null when it is untraced or unknown. */
export function explainCycle(mod: IrModule, key: string): CycleExplanation | null {
  return analyzeCycles(mod, true).explain(key);
}

function analyzeCycles(
  mod: IrModule,
  labels: boolean,
  stores?: DynamicFieldStores,
  precomputed?: CycleMutability,
): {
  shapes: Set<string>;
  unions: Set<string>;
  explain: (key: string) => CycleExplanation | null;
} {
  const classes = mod.classes ?? [];
  // Hierarchy units: root lookup over the base links (classes with a base
  // or a subclass — and the runtime emitter class — form units under their
  // root; standalone classes and records stay singleton units).
  const baseOf = new Map(classes.map((c) => [c.name, c.base ?? null] as const));
  const roots = new Map<string, string>();
  const rootOf = (name: string): string => {
    let cur = name;
    const path: string[] = [];
    while (!roots.has(cur)) {
      path.push(cur);
      const base = baseOf.get(cur);
      if (base === null || base === undefined) break;
      cur = base;
    }
    cur = roots.get(cur) ?? cur;
    for (const member of path) roots.set(member, cur);
    return cur;
  };
  const unitOfClass = (name: string): string => `object:${rootOf(name)}`;
  // ProgramLifetime hierarchies (contract types) are never freed: the
  // collector never walks them, and a garbage cycle cannot
  // pass through an object that is never freed. They are leaves: no edges
  // into them, none out of them.
  const lifetimeRoots = new Set(mod.contracts?.programLifetime ?? []);
  const programLifetime = (className: string): boolean =>
    lifetimeRoots.size > 0 && lifetimeRoots.has(rootOf(className));
  const mutability = precomputed ?? computeCycleMutability(mod, unitOfClass, stores);
  const shapeDefs = [
    ...classes.map((c) => ({
      key: `object:${c.name}`,
      unit: unitOfClass(c.name),
      fields: [
        ...c.fields,
        ...(c.name === RUNTIME_EMITTER_CLASS
          ? [{ name: "<listeners>", type: funcOf([], VOID) }]
          : []),
        // The EventTarget state owns listener values and the target's own
        // capsule; an Event owns its target and detail.
        ...(c.name === RUNTIME_EVENT_TARGET_CLASS || c.name === RUNTIME_EVENT_CLASS
          ? [{ name: "<engine>", type: DYN }]
          : []),
        ...(c.localCaptures !== undefined
          ? [{ name: "<class>", type: { kind: "classval" as const, className: c.name } }]
          : []),
        // An instance of a class that extends Array holds its elements.
        ...(c.arrayElem !== undefined
          ? [{ name: "<elements>", type: { kind: "array" as const, elem: c.arrayElem } }]
          : []),
      ],
    })),
    ...(mod.records ?? []).map((r) => ({
      key: `record:${r.id}`,
      unit: `record:${r.id}`,
      fields: r.indexValue
        ? [...r.fields, { name: "<overflow>", type: mapOf(STRING, r.indexValue) }]
        : r.fields,
    })),
  ];
  interface Node {
    /** The unit key (explanations). */
    name: string;
    intrinsic: boolean;
    /** With labels: the first edge label per dependency (a mutable one
     * preferred), and the field that made the node intrinsic. */
    labels: Map<Node, CycleEdgeLabel> | null;
    intrinsicField: { field: string; holds: IntrinsicKind } | null;
    /** Dependency → whether any edge to it is mutable. */
    edges: Map<Node, boolean>;
    index: number;
    low: number;
    onStack: boolean;
    component: number;
    reverse: Node[];
    traced: boolean;
  }
  const node = (name: string): Node => ({
    name,
    intrinsic: false,
    labels: labels ? new Map() : null,
    intrinsicField: null,
    edges: new Map(),
    index: -1,
    low: 0,
    onStack: false,
    component: -1,
    reverse: [],
    traced: false,
  });
  // One node per class and record, plus a SUBTREE node per class with
  // subclasses: a slot of static type C can hold an instance of any class
  // in C's subtree, and of nothing else. Reachability is computed per
  // class; tracing is then decided per hierarchy unit below.
  const shapes = new Map<string, Node>();
  const unions = new Map((mod.unions ?? []).map((u) => [u.id, node(`union:${u.id}`)]));
  for (const s of shapeDefs) shapes.set(s.key, node(s.key));
  const children = new Map<string, string[]>();
  for (const c of classes)
    if (c.base !== undefined && shapes.has(`object:${c.base}`)) {
      let list = children.get(c.base);
      if (!list) children.set(c.base, (list = []));
      list.push(c.name);
    }
  // Created up front and linked without recursion (hierarchies can be
  // thousands deep).
  const subtrees = new Map(
    [...children.keys()].map((name) => [name, node(`subtree:${name}`)] as const),
  );
  const subtreeOf = (className: string): Node | undefined =>
    subtrees.get(className) ?? shapes.get(`object:${className}`);
  for (const [name, sub] of subtrees) {
    sub.edges.set(shapes.get(`object:${name}`)!, false);
    sub.labels?.set(shapes.get(`object:${name}`)!, { kind: "subclass", className: name });
    for (const kid of children.get(name)!) {
      sub.edges.set(subtreeOf(kid)!, false);
      sub.labels?.set(subtreeOf(kid)!, { kind: "subclass", className: kid });
    }
  }
  // Each field/arm is an OR of intrinsic capability and referenced nodes.
  const addType = (
    from: Node,
    t: IrType,
    mutable: boolean,
    label: CycleEdgeLabel | null = null,
  ): void => {
    if (from.intrinsic) return;
    switch (t.kind) {
      case "func":
      case "dyn":
      case "jsval":
      case "classval":
      case "promise":
      case "caught":
        from.intrinsic = true;
        from.edges.clear();
        if (from.labels !== null) {
          from.labels.clear();
          from.intrinsicField = {
            field: label?.kind === "field" ? label.field : "",
            holds: t.kind,
          };
        }
        break;
      case "object":
      case "record":
      case "union": {
        if (t.kind === "object" && programLifetime(t.className)) break;
        const dependency =
          t.kind === "union"
            ? unions.get(t.unionId)
            : t.kind === "object"
              ? subtreeOf(t.className)
              : shapes.get(`record:${t.shapeId}`);
        if (dependency) {
          const before = from.edges.get(dependency);
          from.edges.set(dependency, (before ?? false) || mutable);
          if (
            from.labels !== null &&
            label !== null &&
            (before === undefined || (!before && mutable))
          )
            from.labels.set(
              dependency,
              label.kind === "field" ? { ...label, mutable: label.mutable || mutable } : label,
            );
        }
        break;
      }
      case "map":
        addType(from, t.key, true, label?.kind === "field" ? { ...label, via: "map" } : label);
        addType(from, t.value, true, label?.kind === "field" ? { ...label, via: "map" } : label);
        break;
      case "set":
      case "array":
        addType(from, t.elem, true, label?.kind === "field" ? { ...label, via: t.kind } : label);
        break;
    }
  };
  for (const s of shapeDefs) {
    if (s.key.startsWith("object:") && programLifetime(s.key.slice("object:".length))) continue;
    const unitMutable = mutability.all || mutability.units.has(s.unit);
    for (const field of s.fields) {
      if (mutability.emptyPropertyBags && field.name === DYN_CLASS_PROPERTIES) continue;
      const mutable = unitMutable || mutability.fields.has(fieldKey(s.unit, field.name));
      addType(
        shapes.get(s.key)!,
        field.type,
        mutable,
        labels ? { kind: "field", field: field.name, mutable } : null,
      );
    }
  }
  for (const u of mod.unions ?? [])
    for (const arm of u.arms)
      addType(unions.get(u.id)!, arm, mutability.all, labels ? { kind: "arm" } : null);

  // Tarjan's strongly connected components, iteratively (shape chains can
  // be thousands deep).
  const all = [...shapes.values(), ...subtrees.values(), ...unions.values()];
  const stack: Node[] = [];
  const componentCapable: boolean[] = [];
  let nextIndex = 0;
  for (const start of all) {
    if (start.index >= 0) continue;
    const work: { n: Node; next: Node[]; i: number }[] = [];
    const enter = (n: Node): void => {
      n.index = n.low = nextIndex++;
      n.onStack = true;
      stack.push(n);
      work.push({ n, next: [...n.edges.keys()], i: 0 });
    };
    enter(start);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.i < frame.next.length) {
        const m = frame.next[frame.i++]!;
        if (m.index < 0) enter(m);
        else if (m.onStack) frame.n.low = Math.min(frame.n.low, m.index);
        continue;
      }
      work.pop();
      const n = frame.n;
      if (work.length > 0) {
        const parent = work[work.length - 1]!.n;
        parent.low = Math.min(parent.low, n.low);
      }
      if (n.low !== n.index) continue;
      const id = componentCapable.length;
      const members: Node[] = [];
      let member: Node;
      do {
        member = stack.pop()!;
        member.onStack = false;
        member.component = id;
        members.push(member);
      } while (member !== n);
      let capable = false;
      for (const m of members) {
        if (m.intrinsic) capable = true;
        for (const [dependency, mutable] of m.edges)
          if (mutable && dependency.component === id) capable = true;
      }
      componentCapable.push(capable);
    }
  }
  // Traced: on a potential cycle. An intrinsic node can reach anything, so
  // every node that reaches one (reverse reachability) may lie on a cycle
  // through it; otherwise only the members of a component with a mutable
  // internal edge can. A node that merely reaches such a component holds it
  // from outside: no cycle can lead back to it, so its references are
  // external counts and it dies by reference counting alone.
  for (const n of all) for (const dependency of n.edges.keys()) dependency.reverse.push(n);
  const reachesIntrinsic = new Set<Node>(all.filter((n) => n.intrinsic));
  const pending = [...reachesIntrinsic];
  for (let i = 0; i < pending.length; i++) {
    for (const dependent of pending[i]!.reverse) {
      if (reachesIntrinsic.has(dependent)) continue;
      reachesIntrinsic.add(dependent);
      pending.push(dependent);
    }
  }
  for (const n of all) n.traced = componentCapable[n.component]! || reachesIntrinsic.has(n);
  // Header presence is uniform across a hierarchy: a unit is traced iff any
  // member class is.
  const tracedUnits = new Set<string>();
  for (const s of shapeDefs) if (shapes.get(s.key)!.traced) tracedUnits.add(s.unit);
  const tracedShapes = new Set(shapeDefs.filter((s) => tracedUnits.has(s.unit)).map((s) => s.key));
  const tracedUnions = new Set([...unions].filter(([, n]) => n.traced).map(([id]) => id));

  /** Shortest path from `start` to a node satisfying `goal`, following
   * only edges `allow` admits. The steps exclude the goal itself. */
  const path = (
    start: Node,
    goal: (n: Node) => boolean,
    allow: (from: Node, to: Node) => boolean,
  ): { steps: CycleStep[]; end: Node } | null => {
    const previous = new Map<Node, Node | null>([[start, null]]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const n = queue[i]!;
      if (goal(n)) {
        const steps: CycleStep[] = [];
        for (
          let at = n, from = previous.get(n)!;
          from !== null;
          at = from, from = previous.get(from)!
        )
          steps.unshift({ from: from.name, label: from.labels?.get(at) ?? { kind: "arm" } });
        return { steps, end: n };
      }
      for (const next of n.edges.keys())
        if (!previous.has(next) && allow(n, next)) {
          previous.set(next, n);
          queue.push(next);
        }
    }
    return null;
  };
  /** BFS distances from `start` over `next` within one component; `via`
   * is the neighbor one step closer to `start`. */
  const distances = (
    start: Node,
    next: (n: Node) => readonly Node[],
    component: number,
  ): Map<Node, { distance: number; via: Node | null }> => {
    const seen = new Map<Node, { distance: number; via: Node | null }>([
      [start, { distance: 0, via: null }],
    ]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i]!;
      const distance = seen.get(at)!.distance + 1;
      for (const m of next(at))
        if (m.component === component && !seen.has(m)) {
          seen.set(m, { distance, via: at });
          queue.push(m);
        }
    }
    return seen;
  };
  const explainNode = (n: Node): CycleExplanation | null => {
    if (!n.traced) return null;
    const component = n.component;
    const inside = (_from: Node, to: Node): boolean => to.component === component;
    const intrinsic = (target: Node, steps: CycleStep[]): CycleExplanation => ({
      kind: "intrinsic",
      steps,
      owner: target.name,
      field: target.intrinsicField?.field ?? "",
      holds: target.intrinsicField?.holds ?? "dyn",
    });
    if (componentCapable[component]!) {
      const members = all.filter((m) => m.component === component);
      const lead = members.find((m) => m.intrinsic);
      if (lead !== undefined) {
        const found = path(n, (m) => m === lead, inside);
        if (found) return intrinsic(lead, found.steps);
      }
      // The shortest cycle through `n` and a mutable internal edge: BFS
      // distances from `n` forward and to `n` backward, within the component.
      const forward = distances(n, (m) => [...m.edges.keys()], component);
      const backward = distances(n, (m) => m.reverse, component);
      let best: { from: Node; to: Node; length: number } | null = null;
      for (const from of members) {
        const there = forward.get(from);
        if (there === undefined) continue;
        for (const [to, mutable] of from.edges) {
          const back = backward.get(to);
          if (!mutable || back === undefined) continue;
          const length = there.distance + 1 + back.distance;
          if (best === null || length < best.length) best = { from, to, length };
        }
      }
      if (best !== null) {
        const steps: CycleStep[] = [];
        for (let at: Node = best.from; at !== n;) {
          const previous = forward.get(at)!.via!;
          steps.unshift({
            from: previous.name,
            label: previous.labels?.get(at) ?? { kind: "arm" },
          });
          at = previous;
        }
        steps.push({
          from: best.from.name,
          label: best.from.labels?.get(best.to) ?? { kind: "arm" },
        });
        for (let at: Node = best.to; at !== n;) {
          const next = backward.get(at)!.via!;
          steps.push({ from: at.name, label: at.labels?.get(next) ?? { kind: "arm" } });
          at = next;
        }
        return { kind: "cycle", steps };
      }
    }
    const found = path(
      n,
      (m) => m.intrinsic,
      () => true,
    );
    return found ? intrinsic(found.end, found.steps) : null;
  };
  const explain = (key: string): CycleExplanation | null => {
    const unionId = key.startsWith("union:") ? key.slice("union:".length) : null;
    const n = unionId !== null ? unions.get(unionId) : shapes.get(key);
    if (n === undefined) return null;
    const own = explainNode(n);
    if (own !== null || unionId !== null) return own;
    const def = shapeDefs.find((d) => d.key === key);
    if (def === undefined || !tracedUnits.has(def.unit)) return null;
    for (const other of shapeDefs) {
      if (other.unit !== def.unit || other.key === key) continue;
      const because = explainNode(shapes.get(other.key)!);
      if (because !== null) return { kind: "hierarchy", member: other.key, because };
    }
    return null;
  };
  return { shapes: tracedShapes, unions: tracedUnions, explain };
}
