// Objects and arrays a Node island made, converted to native types where the
// compiler sees the conversion. Each of the first six copies the island's
// value (SC6007); the forms after them keep the island's object, state the
// copy, or convert a value no island made, and report nothing.
import { anyList, item, list, table, visit } from "copy-kit";

interface Dated {
  a: number;
  at?: Date;
}

const numbers = list() as number[];
const first = item() as Dated;
const held = item();
const second = held as Dated;
const typed: number[] = anyList();
visit((it: Dated): void => {
  it.a += 1;
});
const byItem = table<Map<Dated, string>>();
console.log(numbers.length, first.a, second.a, typed.length, byItem.size);

const kept = item() as { a: unknown };
const cloned = structuredClone(item()) as Dated;
const parsed = JSON.parse('{"a":1}') as Dated;
visit((it: Dated): void => {
  console.log(it.a);
});
const byName = table<Map<string, number>>();
console.log(kept.a, cloned.a, parsed.a, byName.size);

// A record type a view of the island's object can hold is not converted
// where the program gives the island's value that type: the value stays the
// island's object, the callback writes through it, and nothing is reported.
// `Dated` above declares a Date, which a view cannot hold, so it is copied.
interface Item {
  a: number;
  b?: string;
}
const viewed = item() as Item;
const again = held as Item;
visit((it: Item): void => {
  it.a += 1;
});
const byViewed = table<Map<Item, string>>();
console.log(viewed.a, again.a, byViewed.size);
