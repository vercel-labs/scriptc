// Type overloads with one shared implementation: the stored function takes
// the join of the overload parameter types (a scalar union here) and each
// call converts its result back to the resolved overload's type. Records,
// generic overloads, and implementations typed with unions or `any` share
// the same slot.
export {};

interface Converter {
  conv(x: number): string;
  conv(x: string): number;
  conv(x: boolean): boolean;
}
const converter: Converter = {
  conv(x: number | string | boolean): any {
    return typeof x === "number" ? `n${x}` : typeof x === "string" ? x.length : !x;
  },
};
const s: string = converter.conv(12);
const len: number = converter.conv("abcd");
const flipped: boolean = converter.conv(false);
console.log(s.toUpperCase(), len + 1, flipped);

interface Point {
  x: number;
  y: number;
}
interface Named {
  name: string;
}
interface Factory {
  make(kind: "point", a: number, b: number): Point;
  make(kind: "named", a: string): Named;
}
const factory: Factory = {
  make(kind: string, a: number | string, b?: number): any {
    return kind === "point" ? { x: a, y: b } : { name: a };
  },
};
const p = factory.make("point", 3, 4);
const named = factory.make("named", "zed");
console.log(Math.hypot(p.x, p.y), named.name.length, p, named);

// Generic overloads erase their own type parameters to `unknown`.
interface Store {
  get(key: "names", fallback: string[]): string[];
  get(key: "count"): number;
  at<T>(items: T[], i: number): T;
  at(items: string, i: number): string;
}
const data: Record<string, unknown> = { names: ["a", "b"], count: 3 };
const store: Store = {
  get(key: string, fallback?: unknown): any {
    return data[key] ?? fallback;
  },
  at(items: any, i: number): any {
    return items[i];
  },
};
console.log(store.get("names", []).join("|"), store.get("count") * 2);
console.log(store.at([10, 20, 30], 1) + 1, store.at("xyz", 2).toUpperCase());

