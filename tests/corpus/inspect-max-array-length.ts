// util.inspect's maxArrayLength option: an integer bounds the entries shown
// for arrays (holes counted as one `<n empty items>` entry), Map and Set
// values, typed arrays and ArrayBuffer contents, with Node's "... N more
// items" tail counting the entries past the limit; null and Infinity show
// every entry, and custom inspect methods read the resolved value from their
// options.
import * as util from "node:util";
import { inspect } from "node:util";

const list: number[] = [];
for (let i = 0; i < 105; i++) list.push(i);
console.log(inspect(list, { maxArrayLength: 3 }));
console.log(inspect(list, { maxArrayLength: 0 }));
console.log(inspect(list, { maxArrayLength: 0, breakLength: 200 }));
console.log(inspect(list, { maxArrayLength: 40, breakLength: 40 }));
console.log(inspect(list, { maxArrayLength: 2, compact: false }));
console.log(inspect(list, { maxArrayLength: null }));
console.log(inspect(list, { maxArrayLength: Infinity }));
console.log(inspect([1, 2, 3], { maxArrayLength: 2 }));
console.log(inspect([1, 2, 3], { maxArrayLength: 100 }), inspect([], { maxArrayLength: 0 }));
const tuple = [1, 2, 3] as const;
console.log(inspect(tuple, { maxArrayLength: 2 }), inspect(tuple, { maxArrayLength: 0 }));
console.log(inspect(tuple), inspect(tuple, { maxArrayLength: 3 }));
const mixed = [1, "two", true] as const;
console.log(inspect(mixed, { maxArrayLength: 1 }), inspect(mixed, { maxArrayLength: 3 }));

const sparse: Array<number | undefined> = [, , 3, 4, 5];
console.log(inspect(sparse, { maxArrayLength: 2 }));
console.log(inspect(sparse, { maxArrayLength: 1 }));
console.log(inspect(sparse, { maxArrayLength: 0, breakLength: 200 }));
const trailing: Array<number | undefined> = [1, , ,];
console.log(inspect(trailing, { maxArrayLength: 1 }), inspect(trailing, { maxArrayLength: 2 }));

const nested: number[][] = [];
for (let i = 0; i < 5; i++) nested.push([i, i + 1, i + 2, i + 3]);
console.log(inspect(nested, { maxArrayLength: 2 }));
console.log(inspect({ x: [1, 2, 3, 4, 5], y: { z: [6, 7, 8, 9] } }, { maxArrayLength: 2 }));

const set = new Set<number>();
const map = new Map<number, number>();
for (let i = 0; i < 105; i++) {
  set.add(i);
  map.set(i, i * 2);
}
console.log(inspect(set, { maxArrayLength: 3 }));
console.log(inspect(set, { maxArrayLength: 0 }));
console.log(inspect(set, { maxArrayLength: null }));
console.log(inspect(map, { maxArrayLength: 2 }));
console.log(
  inspect(new Set([1, 2, 3]), { maxArrayLength: 1 }),
  inspect(new Map([[1, 2]]), { maxArrayLength: 0 }),
);

// A Map or Set entry iterator lists whole `[ key, value ]` pairs: the limit
// bounds the number of entries and never trims a pair, while a key or value
// inside the pair keeps its own limit.
const pairs = new Map<string, number[]>([
  ["a", [1, 2, 3]],
  ["b", [4]],
]);
console.log(inspect(pairs.entries(), { maxArrayLength: 1, breakLength: 200 }));
console.log(inspect(pairs.entries(), { maxArrayLength: 0, breakLength: 200 }));
console.log(inspect(pairs.entries(), { maxArrayLength: null, breakLength: 200 }));
console.log(inspect(pairs.keys(), { maxArrayLength: 1, breakLength: 200 }));
const setPairs = new Set<number[]>([[1, 2], [3]]);
console.log(inspect(setPairs.entries(), { maxArrayLength: 1, breakLength: 200 }));
// A value inside the pair renders at the pair's own level, so depth reaches
// it the way Node's iterator formatting does.
console.log(inspect({ it: pairs.entries() }, { depth: 1, breakLength: 200 }));

const typed = new Uint16Array(150);
console.log(inspect(typed, { maxArrayLength: 4 }));
console.log(inspect(typed, { maxArrayLength: 0 }));
console.log(inspect(typed, { maxArrayLength: null }));
console.log(inspect(new Uint8Array([9, 8, 7]), { maxArrayLength: 2 }));
console.log(inspect({ bytes: new Uint8Array(10) }, { maxArrayLength: 3 }));

const buffer = new ArrayBuffer(12);
console.log(inspect(buffer, { maxArrayLength: 4 }));
console.log(inspect(buffer, { maxArrayLength: 0 }));
console.log(inspect(buffer, { maxArrayLength: null }));

const computed: number = list.length - 103;
const computedOptions = { maxArrayLength: computed };
console.log(inspect(list, computedOptions));
console.log(util.formatWithOptions({ maxArrayLength: 2 }, "%O", [1, 2, 3, 4]));

console.dir([1, 2, 3], { maxArrayLength: 1 });
console.dir(new Set([1, 2, 3]), { maxArrayLength: 0, depth: 2 });

class Probe {
  [util.inspect.custom](depth: number | null, options: util.InspectOptionsStylized): string {
    return `Probe<depth=${depth} maxArrayLength=${options.maxArrayLength}>`;
  }
}
console.log(inspect(new Probe(), { maxArrayLength: 7 }));
console.log(inspect(new Probe(), { maxArrayLength: null }));
console.log(inspect(new Probe()));
console.log(inspect([new Probe()], { maxArrayLength: 1 }));
