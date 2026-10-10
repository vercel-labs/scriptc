import type { IrModule, IrType } from "../ir/ir.js";
import {
  DYN_CLASS_PROPERTIES,
  funcOf,
  mapOf,
  RUNTIME_EMITTER_CLASS,
  STRING,
  VOID,
} from "../ir/ir.js";
import { computeCycleMutability, fieldKey } from "./cycle-mutability.js";

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
export function computeTraced(mod: IrModule): { shapes: Set<string>; unions: Set<string> } {
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
  const mutability = computeCycleMutability(mod, unitOfClass);
  const shapeDefs = [
    ...classes.map((c) => ({
      key: `object:${c.name}`,
      unit: unitOfClass(c.name),
      fields: [
        ...c.fields,
        ...(c.name === RUNTIME_EMITTER_CLASS
          ? [{ name: "<listeners>", type: funcOf([], VOID) }]
          : []),
        ...(c.localCaptures !== undefined
          ? [{ name: "<class>", type: { kind: "classval" as const, className: c.name } }]
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
    intrinsic: boolean;
    /** Dependency → whether any edge to it is mutable. */
    edges: Map<Node, boolean>;
    index: number;
    low: number;
    onStack: boolean;
    component: number;
    reverse: Node[];
    traced: boolean;
  }
  const node = (): Node => ({
    intrinsic: false,
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
  const unions = new Map((mod.unions ?? []).map((u) => [u.id, node()]));
  for (const s of shapeDefs) shapes.set(s.key, node());
  const children = new Map<string, string[]>();
  for (const c of classes)
    if (c.base !== undefined && shapes.has(`object:${c.base}`)) {
      let list = children.get(c.base);
      if (!list) children.set(c.base, (list = []));
      list.push(c.name);
    }
  // Created up front and linked without recursion (hierarchies can be
  // thousands deep).
  const subtrees = new Map([...children.keys()].map((name) => [name, node()] as const));
  const subtreeOf = (className: string): Node | undefined =>
    subtrees.get(className) ?? shapes.get(`object:${className}`);
  for (const [name, sub] of subtrees) {
    sub.edges.set(shapes.get(`object:${name}`)!, false);
    for (const kid of children.get(name)!) sub.edges.set(subtreeOf(kid)!, false);
  }
  // Each field/arm is an OR of intrinsic capability and referenced nodes.
  const addType = (from: Node, t: IrType, mutable: boolean): void => {
    if (from.intrinsic) return;
    switch (t.kind) {
      case "func":
      case "dyn":
      case "classval":
      case "promise":
      case "caught":
        from.intrinsic = true;
        from.edges.clear();
        break;
      case "object":
      case "record":
      case "union": {
        const dependency =
          t.kind === "union"
            ? unions.get(t.unionId)
            : t.kind === "object"
              ? subtreeOf(t.className)
              : shapes.get(`record:${t.shapeId}`);
        if (dependency)
          from.edges.set(dependency, (from.edges.get(dependency) ?? false) || mutable);
        break;
      }
      case "map":
        addType(from, t.key, true);
        addType(from, t.value, true);
        break;
      case "set":
      case "array":
        addType(from, t.elem, true);
        break;
    }
  };
  for (const s of shapeDefs) {
    const unitMutable = mutability.all || mutability.units.has(s.unit);
    for (const field of s.fields) {
      if (mutability.emptyPropertyBags && field.name === DYN_CLASS_PROPERTIES) continue;
      addType(
        shapes.get(s.key)!,
        field.type,
        unitMutable || mutability.fields.has(fieldKey(s.unit, field.name)),
      );
    }
  }
  for (const u of mod.unions ?? [])
    for (const arm of u.arms) addType(unions.get(u.id)!, arm, mutability.all);

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
  return { shapes: tracedShapes, unions: tracedUnions };
}
