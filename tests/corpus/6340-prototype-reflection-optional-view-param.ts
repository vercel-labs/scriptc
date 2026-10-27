// A generic method whose optional parameter is an interface view (or an
// erased type parameter) reflects through the prototype of an instance
// that crossed into checked-dynamic code, and calls directly with the
// argument omitted.
interface Handle {
  close(): string;
}
class Plain implements Handle {
  close(): string {
    return "closed";
  }
}
class Registry {
  private current: Handle | null = null;
  use(handle: Handle | null): void {
    this.current = handle;
  }
  wrap<F>(fn: F, handle?: Handle | null): F {
    if (handle) this.current = handle;
    return fn;
  }
  tag<T>(value: T, label?: T): string {
    return `${String(value)}:${label === undefined ? "none" : String(label)}`;
  }
  size(): number {
    return this.current === null ? 0 : 1;
  }
}

const registry = new Registry();
const inc = registry.wrap((x: number) => x + 1);
console.log(inc(1), registry.size());
const dec = registry.wrap((x: number) => x - 1, new Plain());
console.log(dec(1), registry.size());
console.log(registry.tag(1), registry.tag("a", "b"));

const boxed: unknown = registry;
const proto = Object.getPrototypeOf(boxed);
console.log(Object.getOwnPropertyNames(proto).join(","));
console.log(typeof proto.wrap, typeof proto.tag, proto.size.call(registry));
const loose: any = registry;
console.log(loose.size(), proto.tag.call(registry, 2), proto.tag.call(registry, 2, 3));
