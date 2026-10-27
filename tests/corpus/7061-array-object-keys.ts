// Object.keys, Object.values and Object.entries of a typed array list the
// present indices, then its numeric properties ("-1", "1.5"), then its
// named properties, as in Node. Holes are skipped.

type Bag = Record<string, unknown>;

const words: string[] = ["p", "q"];
words[-1] = "x";
(words as unknown as Bag)["1.5"] = "y";
(words as unknown as Bag).label = "named";
console.log(Object.keys(words), Object.values(words), Object.entries(words));
console.log((words as unknown as Bag)["-1"], words[1.5], "1.5" in (words as unknown as Bag));
for (const key of Object.keys(words)) console.log(key, key.length);

const holes: (number | undefined)[] = [1, , 3, undefined];
console.log(Object.keys(holes), Object.values(holes), Object.entries(holes));

const empty: number[] = [];
console.log(Object.keys(empty).length, Object.entries(empty));

interface Point {
  x: number;
}
const points: Point[] = [{ x: 1 }, { x: 2 }];
console.log(Object.keys(points), Object.values(points));
const keys: string[] = Object.keys(points);
keys.push("extra");
console.log(keys.join("|"), Object.keys(points).length);
