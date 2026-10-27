// util.format, formatWithOptions and console.log %j over circular values:
// Node's tryStringify prints "[Circular]" when JSON.stringify throws the
// circular-structure TypeError, and rethrows every other error. A checked-
// dynamic argument stringifies as JSON.stringify does (toJSON hooks,
// dropped members, shared references); a recursive typed value prints
// "[Circular]" where JSON.stringify throws.
import { format, formatWithOptions } from "node:util";

const parsed = JSON.parse('{"name":"root","children":[{"name":"leaf"}]}');
parsed.children[0].parent = parsed;
console.log(format("%j", parsed));
console.log(format("%j|%j", parsed.children, parsed.children[0].name));
console.log("%j", parsed);

const bag: Record<string, unknown> = { id: 1 };
bag.self = bag;
console.log(format("%j", bag), formatWithOptions({}, "[%j]", bag));

const list: unknown[] = [1, 2];
list.push(list);
console.log(format("%j", list), format("%j", [list]));

const shared = { s: 1 };
const twice: unknown = { a: shared, b: shared };
console.log(format("%j", twice));

const hooked: unknown = { toJSON: (key: string) => `toJSON(${JSON.stringify(key)})` };
const dropped: unknown = { skip: undefined, n: NaN, f: () => 1 };
console.log(format("%j %j", hooked, dropped));

const big: unknown = { n: 1n };
try {
  format("%j", big);
} catch (error) {
  console.log("rethrown", (error as Error).name, (error as Error).message);
}
const ranged: unknown = {
  toJSON: () => {
    throw new RangeError("Converting circular structure to JSON");
  },
};
try {
  format("%j", ranged);
} catch (error) {
  console.log("rethrown", (error as Error).name);
}
const firstLine: unknown = {
  toJSON: () => {
    throw new TypeError("Converting circular structure to JSON\n    --> elsewhere");
  },
};
console.log(format("%j", firstLine));

interface Item {
  name: string;
  next: Item | null;
}
const item: Item = { name: "a", next: null };
console.log(format("%j", item));
item.next = { name: "b", next: item };
console.log(format("%j", item), format("%j", [item]));
console.log("%j and %j", { item }, 5);
try {
  JSON.stringify(item);
} catch (error) {
  console.log((error as Error).name, (error as Error).message.split("\n")[0]);
}
