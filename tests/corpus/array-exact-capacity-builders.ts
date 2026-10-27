// Arrays whose final length is known while they are built: map results,
// new Array(n) filled by index, concat results, spread literals and
// Array.from({ length: n }). Holes, lengths and later appends behave as
// in JavaScript.
class Item {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}
const items: Item[] = [];
for (let i = 0; i < 9; i++) items.push(new Item(i));
const ids = (xs: Item[]): string => xs.map((x) => x.id).join(",");

const doubled = items.map((x) => new Item(x.id * 2));
console.log(doubled.length, ids(doubled));
doubled.push(new Item(99));
console.log(doubled.length, ids(doubled));

const filled: Item[] = new Array<Item>(5);
for (let i = 0; i < filled.length; i++) filled[i] = items[i]!;
console.log(filled.length, ids(filled));
const partial: number[] = new Array<number>(6);
partial[1] = 10;
partial[4] = 40;
console.log(partial.length, 0 in partial, 1 in partial, JSON.stringify(partial));
partial.push(7);
console.log(partial.length, JSON.stringify(partial));

const wide: number[] = [];
wide.length = 200000;
wide[150000] = 1;
console.log(wide.length, wide[150000], 5 in wide);
const empty: number[] = [];
empty.length = 0;
empty.push(3);
console.log(empty.length, empty[0]);

const left = items.slice(0, 3);
const right = items.slice(3, 7);
const joined = left.concat(right, items.slice(8));
console.log(joined.length, ids(joined));
const holey: number[] = [1, 2, 3];
holey.length = 5;
const withHoles = holey.concat([6, 7]);
console.log(withHoles.length, 3 in withHoles, 4 in withHoles, JSON.stringify(withHoles));

const spread = [new Item(-1), ...left, new Item(-2), ...right, new Item(-3)];
console.log(spread.length, ids(spread));
const spreadHoles = [...holey, 9];
console.log(spreadHoles.length, 3 in spreadHoles, JSON.stringify(spreadHoles));
const self = [...left, ...left];
console.log(self.length, ids(self));

const zeros = Array.from({ length: 7 }, () => 0);
console.log(zeros.length, zeros.join(""));
const counted = Array.from({ length: 4 }, (_, i) => i * i);
console.log(counted.join(","));
const none = Array.from({ length: 0 }, () => 1);
console.log(none.length);

const sparseSource: number[] = [];
sparseSource[3] = 30;
const mapped = sparseSource.map((x) => x + 1);
console.log(mapped.length, 0 in mapped, 3 in mapped, mapped[3]);
