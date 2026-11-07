// Objects and arrays a Node island made, converted to native types where the
// compiler sees the conversion. Each of the first six copies the island's
// value (SC6007); the forms after them keep the island's object, state the
// copy, or convert a value no island made, and report nothing.
import { anyList, item, list, table, visit } from "copy-kit";

interface Item {
  a: number;
  b?: string;
}

const numbers = list() as number[];
const first = item() as Item;
const held = item();
const second = held as Item;
const typed: number[] = anyList();
visit((it: Item): void => {
  it.a += 1;
});
const byItem = table<Map<Item, string>>();
console.log(numbers.length, first.a, second.a, typed.length, byItem.size);

const kept = item() as { a: unknown };
const cloned = structuredClone(item()) as Item;
const parsed = JSON.parse('{"a":1}') as Item;
visit((it: Item): void => {
  console.log(it.a);
});
const byName = table<Map<string, number>>();
console.log(kept.a, cloned.a, parsed.a, byName.size);
