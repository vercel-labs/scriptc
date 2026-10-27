// Named properties written to a typed array through an `unknown` view stay
// on the array: later views read them, key walks list them after the
// indices, and `for...in` over the typed array visits them. Holes are
// skipped by `for...in`.

type Bag = Record<string, unknown>;

const numbers: number[] = [1, 2, 3];
const numbersView = numbers as unknown as Bag;
numbersView.extra = "named";
console.log(numbersView.extra, (numbers as unknown as Bag).extra);
console.log(Object.keys(numbersView), JSON.stringify(numbers), numbers.length);
console.log("extra" in numbersView, Object.hasOwn(numbersView, "extra"));

numbers.push(4);
numbers[0] = 10;
console.log((numbers as unknown as Bag).extra, numbers.join(","));
console.log((numbers.slice() as unknown as Bag).extra);

(numbers as unknown as Bag).extra = "again";
(numbers as unknown as Bag).count = 2;
console.log(Object.entries(numbers as unknown as Bag));
for (const key in numbers) console.log("numbers key", key);

delete (numbers as unknown as Bag).extra;
console.log((numbers as unknown as Bag).extra, Object.keys(numbers as unknown as Bag));

const words: string[] = ["a", "b"];
(words as unknown as Bag).label = { nested: [1, 2] };
const label = (words as unknown as Bag).label as { nested: number[] };
console.log(label.nested.length, words.length);
for (const key in words) console.log("words key", key);

interface Point {
  x: number;
  y: number;
}
const points: Point[] = [{ x: 1, y: 2 }];
(points as unknown as Bag).origin = "zero";
console.log((points as unknown as Bag).origin, points[0]!.x);
for (const key in points) console.log("points key", key);

class Item {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}
const items: Item[] = [new Item("first")];
(items as unknown as Bag).kind = "items";
console.log((items as unknown as Bag).kind, items[0]!.name);

const flags: boolean[] = [true, false];
Object.defineProperty(flags as unknown as Bag, "hidden", { value: 1, enumerable: false });
(flags as unknown as Bag).shown = 2;
console.log((flags as unknown as Bag).hidden, (flags as unknown as Bag).shown);
for (const key in flags) console.log("flags key", key);

const holes: (number | undefined)[] = [1, , 3, undefined];
for (const key in holes) console.log("holes key", key);
(holes as unknown as Bag).tail = true;
for (const key in holes) console.log("holes key after", key);

const offsets: number[] = [1, 2];
offsets[-1] = 5;
offsets[1.5] = 6;
(offsets as unknown as Bag).name = "offsets";
console.log(offsets[-1], offsets[1.5], (offsets as unknown as Bag).name);
for (const key in offsets) console.log("offsets key", key);

const shrinking: number[] = [1, 2, 3, 4];
(shrinking as unknown as Bag).after = "kept";
for (const key in shrinking) {
  console.log("shrinking key", key);
  if (key === "1") shrinking.length = 2;
}

const match = /b(?<rest>c)?/.exec("abc");
if (match) for (const key in match) console.log("match key", key);

// A numeric property deleted through a view is gone from the array.
const numeric: number[] = [1, 2];
numeric[-1] = 5;
delete (numeric as unknown as Bag)["-1"];
console.log(numeric[-1], "-1" in (numeric as unknown as Bag));
for (const key in numeric) console.log("numeric key", key);

// A numeric-looking key written through a view is deleted through a view too.
const viewNumeric: string[] = ["a"];
(viewNumeric as unknown as Bag)["-2"] = "view";
console.log((viewNumeric as unknown as Bag)["-2"], "-2" in (viewNumeric as unknown as Bag));
delete (viewNumeric as unknown as Bag)["-2"];
console.log((viewNumeric as unknown as Bag)["-2"], "-2" in (viewNumeric as unknown as Bag));
for (const key in viewNumeric) console.log("view numeric key", key);

// A named key deleted before its turn is not visited.
const visited: number[] = [1];
(visited as unknown as Bag).first = 1;
(visited as unknown as Bag).second = 2;
(visited as unknown as Bag).third = 3;
for (const key in visited) {
  console.log("visited key", key);
  if (key === "first") delete (visited as unknown as Bag).second;
}
