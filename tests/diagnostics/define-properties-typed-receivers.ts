// Object.defineProperties and Object.defineProperty refuse the same
// receivers: a typed object has declared fields and no property table to
// extend, so the call is refused where it is written instead of dropping
// the definition.
interface Point {
  x: number;
  y: number;
}
interface Wider extends Point {
  z: number;
}

const point: Point = { x: 1, y: 2 };
Object.defineProperties(point, { x: { value: 10 } });
Object.defineProperty(point, "x", { value: 10 });

const plain = { x: 1, y: 2 };
Object.defineProperties(plain as Wider, { z: { value: 3, enumerable: true } });
Object.defineProperty(plain as Wider, "z", { value: 3, enumerable: true });

const table: Record<string, number> = { a: 1 };
Object.defineProperties(table, { b: { value: 2 } });
Object.defineProperty(table, "b", { value: 2 });

const list = [1, 2, 3];
Object.defineProperties(list, { extra: { value: "e" } });
Object.defineProperty(list, "extra", { value: "e" });

const lookup = new Map<string, number>();
Object.defineProperties(lookup, { tag: { value: "m" } });
Object.defineProperty(lookup, "tag", { value: "m" });

// A class value whose constructor keeps no property table.
class Registry {
  static count = 1;
}
Object.defineProperties(Registry, { version: { value: "1.0" } });

// A declared field takes a data descriptor; an accessor for it is refused by
// name, through either call.
class Holder {
  value = 1;
}
const holder = new Holder();
Object.defineProperties(holder, { value: { get: () => 2 } });
Object.defineProperty(holder, "value", { get: () => 2 });
