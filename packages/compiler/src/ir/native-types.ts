import type { IrModule, IrType } from "./ir.js";
import { typeKey } from "./ir.js";

/** Reachability facts only. Membership does not freeze a value or grant a
 * constructor-store exemption; each lifecycle owner applies its own policy. */
export class NativeTypes {
  readonly classes = new Set<string>();
  readonly records = new Set<string>();
  readonly containers = new Set<string>();

  classGuarded(className: string): boolean {
    return this.classes.has(className);
  }
  recordGuarded(shapeId: string): boolean {
    return this.records.has(shapeId);
  }
  requiresHeapIdentity(type: IrType): boolean {
    return (
      (type.kind === "record" && this.recordGuarded(type.shapeId)) ||
      (type.kind === "object" && this.classGuarded(type.className))
    );
  }
  containerGuarded(type: IrType): boolean {
    return (
      (type.kind === "array" || type.kind === "map" || type.kind === "set") &&
      this.containers.has(typeKey(type))
    );
  }
}

/** Close over storage and whole class hierarchies. Checked-dynamic exposure
 * also follows generated callable, promise and generator adapters; publication
 * deliberately keeps its narrower storage traversal. */
export function reachNativeTypes(
  mod: IrModule,
  roots: readonly IrType[],
  out: NativeTypes,
  exposure = false,
): void {
  const classes = new Map((mod.classes ?? []).map((c) => [c.name, c]));
  const children = new Map<string, string[]>();
  for (const cls of classes.values())
    if (cls.base !== undefined) {
      let list = children.get(cls.base);
      if (!list) children.set(cls.base, (list = []));
      list.push(cls.name);
    }
  const records = new Map((mod.records ?? []).map((r) => [r.id, r]));
  const unions = new Map((mod.unions ?? []).map((u) => [u.id, u]));
  const seen = new Set<string>();
  const stack = [...roots];
  const addHierarchy = (className: string): void => {
    let root = className;
    for (
      let c = classes.get(root);
      c?.base !== undefined && classes.has(c.base);
      c = classes.get(root)
    )
      root = c.base;
    const todo = [root];
    while (todo.length > 0) {
      const name = todo.pop()!;
      if (out.classes.has(name)) continue;
      out.classes.add(name);
      for (const f of classes.get(name)?.fields ?? []) stack.push(f.type);
      todo.push(...(children.get(name) ?? []));
    }
  };
  while (stack.length > 0) {
    const t = stack.pop()!;
    const key = typeKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    switch (t.kind) {
      case "object":
        addHierarchy(t.className);
        break;
      case "record": {
        out.records.add(t.shapeId);
        const shape = records.get(t.shapeId);
        for (const f of shape?.fields ?? []) stack.push(f.type);
        if (shape?.indexValue) stack.push(shape.indexValue);
        break;
      }
      case "array":
      case "set":
        out.containers.add(key);
        stack.push(t.elem);
        break;
      case "map":
        out.containers.add(key);
        stack.push(t.key, t.value);
        break;
      case "union":
        stack.push(...(unions.get(t.unionId)?.arms ?? []));
        break;
      case "func":
        if (exposure) stack.push(...t.params, t.ret);
        break;
      case "promise":
        if (exposure) stack.push(t.inner);
        break;
      case "generator":
        if (exposure) stack.push(t.yieldT, t.retT, t.nextT);
        break;
      default:
        break;
    }
  }
}
