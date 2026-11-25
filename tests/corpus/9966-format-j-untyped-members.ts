// %j writes what JSON.stringify writes for a record or an array with
// untyped members: the value's own walk, not a refusal.
import { format } from "node:util";

type Reader = typeof String | typeof Number | typeof Boolean;

// A record whose members hold a table and a list of constructors.
const layout = {
  label: "t",
  casts: { title: String, lent: Boolean } as Record<string, Reader>,
  order: [Number, String] as Reader[],
};
console.log(format("%j", layout));
console.log(JSON.stringify(layout));

// A record with an `unknown` member, alone and in an array.
interface Card {
  title: string;
  note: unknown;
}
const first: Card = { title: "first", note: 1 };
const second: Card = { title: "second", note: { by: "a", tags: ["x", "y"] } };
const third: Card = { title: "third", note: undefined };
const fourth: Card = { title: "fourth", note: null };
const cards: Card[] = [first, second, third, fourth];
console.log(format("%j", first));
console.log(format("%j", cards));
console.log(format("%j %j", second, third), JSON.stringify(fourth));
console.log("%j", { held: second.note, n: 2 });

// The same value twice is not a cycle; a cycle prints as %j prints it.
const shared: unknown = { deep: [1, 2] };
console.log(format("%j", { a: shared, b: shared }));
const loop: { name: string; self: unknown } = { name: "loop", self: null };
loop.self = loop;
console.log(format("%j", loop));
