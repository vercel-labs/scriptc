// Removing the last element with a statement-level pop() or `length = n`,
// for every element kind, on dense arrays, arrays with holes and present
// undefined values, sparse arrays and arrays shared between bindings.
// Removed references are released; the remaining elements, the length and
// later appends match Node.

class Item {
  readonly id: number;
  constructor(id: number) {
    this.id = id;
  }
}

function show(label: string, values: unknown[]): void {
  const parts: string[] = [];
  for (let i = 0; i < values.length; i++) {
    if (!(i in values)) parts.push("<hole>");
    else {
      const v = values[i];
      parts.push(v instanceof Item ? `I${v.id}` : (JSON.stringify(v) ?? "undefined"));
    }
  }
  console.log(label, values.length, parts.join(" "));
}

const numbers = [1.5, 2.5, 3.5, 4.5];
numbers.pop();
numbers.length = numbers.length - 1;
numbers.push(9);
show("numbers", numbers);

const flags = [true, false, true];
flags.pop();
flags.length = 1;
flags.push(false);
show("flags", flags);

const words = ["a", "b", "c", "d"];
const alias = words;
words.pop();
alias.length = alias.length - 1;
words.push("z");
show("words", words);
show("alias", alias);

const items = [new Item(1), new Item(2), new Item(3)];
const kept = items[2]!;
items.pop();
items.length = 1;
items.push(new Item(4));
show("items", items);
console.log("kept", kept.id);

// Holes and present undefined at the end.
const holes: (number | undefined)[] = [1, 2];
holes[4] = 5;
holes.length = 4;
show("holes trimmed", holes);
holes.length = 3;
show("holes trimmed again", holes);
const undef: (string | undefined)[] = ["x", undefined, undefined];
undef.pop();
undef.length = undef.length - 1;
show("undefined", undef);

// A sparse array: a far index then shrinking past it and back by one.
const sparse: number[] = [1, 2, 3];
sparse[2000000] = 4;
sparse.length = 2000000;
show("sparse cut", sparse.slice(0, 4));
console.log("sparse length", sparse.length, 1999999 in sparse);
sparse.length = sparse.length - 1;
console.log("sparse length", sparse.length);

// A stack used the way a checker pushes and pops contextual entries.
const stack: Item[] = [];
const top: number[] = [];
let checksum = 0;
for (let i = 0; i < 20000; i++) {
  stack.push(new Item(i));
  top.push(i);
  if (i % 3 === 2) {
    stack.pop();
    top.length = top.length - 1;
  }
  if (stack.length > 50) {
    stack.length = stack.length - 1;
    top.pop();
  }
  checksum = (checksum + stack[stack.length - 1]!.id + top[top.length - 1]!) % 1000003;
}
console.log("stack", stack.length, top.length, checksum);

// Lengths that are not one less: unchanged, longer, invalid.
const other = [1, 2, 3];
other.length = 3;
other.length = 5;
show("longer", other);
other.length = 1;
show("shorter by many", other);
try {
  other.length = -1;
} catch (e) {
  console.log("invalid", (e as Error).name, other.length);
}
try {
  other.length = 0.5;
} catch (e) {
  console.log("fraction", (e as Error).name, other.length);
}
const empty: number[] = [];
empty.pop();
empty.length = 0;
show("empty", empty);

// pop() results: the last element, undefined for an empty array, a hole or a
// present undefined, and values taken from sparse storage.
const nums = [0.5, -0, 7];
console.log("pop number", nums.pop(), Object.is(nums.pop(), -0), nums.pop(), nums.pop(), nums.length);
const bools = [false, true];
console.log("pop bool", bools.pop(), bools.pop(), bools.pop(), bools.length);
const strs = ["p", "q"];
const strAlias = strs;
console.log("pop string", strs.pop(), strAlias.pop(), strs.pop(), strAlias.length);
const objs = [new Item(7), new Item(8)];
const popped = objs.pop();
console.log("pop item", popped?.id, objs.pop()?.id, objs.pop(), objs.length);
const gaps: number[] = [1];
gaps[3] = 4;
console.log("pop gaps", gaps.pop(), gaps.pop(), gaps.pop(), gaps.pop(), gaps.pop(), gaps.length);
const maybe: (number | undefined)[] = [1, undefined];
console.log("pop present undefined", maybe.pop(), maybe.length, maybe.pop(), maybe.length);
const far: string[] = ["a"];
far[100000] = "b";
console.log("pop sparse", far.pop(), far.length, far.pop(), far.length);
let popTotal = 0;
const work: number[] = [];
for (let i = 0; i < 10000; i++) {
  work.push(i, i + 1);
  popTotal += work.pop()!;
  if (i % 5 === 0) popTotal += work.pop() ?? -1;
}
console.log("pop loop", work.length, popTotal);
