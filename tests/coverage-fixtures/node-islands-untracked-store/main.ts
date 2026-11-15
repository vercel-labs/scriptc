import { keep, loose, raw } from "store-kit";

interface Item {
  name: string;
  count: number;
}

// Followed: an assertion, a const, a parameter and a return of the
// program's own functions, and whatever goes back to the island.
const direct = raw("a") as Item;
const held = raw("b");
const viewed = held as Item;
function asItem(value: unknown): Item {
  return value as Item;
}
function fetchRaw(name: string): unknown {
  return raw(name);
}
const through = asItem(fetchRaw("c"));
keep(raw("d"));
keep({ item: raw("e") });
console.log(direct.name, viewed.name, through.name, typeof raw("f"), String(loose("g")));

// Stored where the origin is no longer followed: each is reported.
const bag: unknown[] = [];
bag.push(raw("h"));
const byName = new Map<string, unknown>();
byName.set("i", raw("i"));
let latest: unknown = raw("j");
latest = raw("k");
const box: { value?: unknown } = {};
box.value = held;
const pair = { first: raw("l"), second: 1 };
const list = [loose("m")];
class Cache {
  last: unknown = raw("n");
}
function hold<T>(value: T): T {
  return value;
}
const kept = hold(raw("o"));

// Read back, the assertion is the checked conversion: a copy.
const copied = bag[0] as Item;
console.log(copied.name, byName.size, typeof latest, typeof box.value, pair.second, list.length);
console.log(typeof new Cache().last, typeof kept);
