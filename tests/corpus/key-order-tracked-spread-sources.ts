// A tracked record type (its values are created in orders no one table
// describes) built from sources that no other surface enumerates. Each
// construction snapshots the own keys of the values it spreads or copies,
// so every source keeps the order its values were created in, not the order
// its type declares.
interface Flags { a?: number; b?: number; c?: number; d?: number }
function merge(p: Flags, q: Flags): Flags {
  return { ...p, ...q };
}
function keysIn(value: object): string {
  const out: string[] = [];
  for (const k in value) out.push(k);
  return out.join(",");
}
function show(tag: string, r: Flags): void {
  console.log(tag, Object.keys(r).join(","), keysIn(r), JSON.stringify(r), Object.entries(r).length);
}
show("merge", merge({ b: 1 }, { a: 2 }));

// A source created in one order its type does not declare.
interface Src { a: number; b: number }
const src: Src = { b: 1, a: 2 };
show("spread-after", { c: 3, ...src });
show("spread-before", { ...src, c: 3 });

// A source whose own values copy another type's order.
interface Inner { d: number; a: number }
interface Outer { a: number; d: number; b: number }
const inner: Inner = { d: 4, a: 1 };
const outer: Outer = { b: 2, ...inner };
show("two-level", { c: 3, ...outer });

// A source created in two orders, so its own values differ.
interface Two { a: number; b: number }
function makeTwo(flip: boolean): Two {
  return flip ? { b: 1, a: 2 } : { a: 1, b: 2 };
}
show("two-orders-flip", { c: 3, ...makeTwo(true) });
show("two-orders-plain", { c: 3, ...makeTwo(false) });

// A rest copy into a tracked type.
interface Wide { z: number; b: number; a: number }
const wide: Wide = { z: 0, b: 1, a: 2 };
const { z, ...rest } = wide;
show("rest", { c: z, ...rest });
