// @requires-libnode
// An npm package scriptc refuses natively (its loader uses a computed
// require() specifier) runs in a Node island: its objects cross as
// handles, so the same object returned twice is ===, and writes through
// one reference are visible through every other, on both sides.
import { Store, createStore, describe, VERSION, makePoint, addPoints, ping } from "islandkit";
import * as kit from "islandkit";

console.log(VERSION);
const s = createStore("fruits");
const apple = s.add("apple", 3);
const banana = s.add("banana", 5);
console.log(s.name, s.size, s.total());

const again = s.get("apple");
console.log("identity", apple === again, apple !== banana, again === s.first());
console.log("owner", apple.owner === s, banana.owner === s);

apple.value = 10;
console.log("alias", s.get("apple")!.value, s.total());

s.rename(apple, "apricot");
console.log(apple.name, describe(apple), s.get("apricot") === apple);

const missing = s.get("cherry");
console.log("missing", missing === undefined);

const veg = new Store("veg");
veg.add("kale", 1);
console.log(veg.name, veg.size, veg instanceof Store, s instanceof kit.Store);
console.log(veg.first() !== null, new Store("empty").first() === null);

const p = addPoints(makePoint(1, 2), { x: 3, y: 4 });
console.log(p.x, p.y);
p.x = 100;
console.log(p.x + p.y);

console.log(ping(), ping(), kit.ping());

try {
  s.add("", 1);
} catch (e) {
  console.log("caught", (e as Error).message);
}

function heaviest(store: Store, names: string[]): string {
  let best = "";
  let max = -Infinity;
  for (const n of names) {
    const e = store.get(n);
    if (e !== undefined && e.value > max) {
      max = e.value;
      best = e.name;
    }
  }
  return best;
}
console.log("heaviest", heaviest(s, ["apricot", "banana", "cherry"]));
