// `.find`, `.findLast` and `.filter` with a callback written as a type
// predicate. At run time the callback is an ordinary test, and what the
// search answers is the element itself: the same object, typed as the
// predicate says.
interface Book {
  id: number;
}
interface Tagged extends Book {
  tags: string[];
}

const atlas: Book = { id: 1 };
const novel: Tagged = { id: 2, tags: ["fiction", "long"] };
const diary: Tagged = { id: 3, tags: [] };
const shelf: Array<Book | Tagged> = [atlas, novel, diary];

function isTagged(item: Book | Tagged): item is Tagged {
  return "tags" in item;
}
function taggedById(id: number): Tagged | undefined {
  return shelf.find((item): item is Tagged => "tags" in item && item.id === id);
}

console.log(taggedById(2)?.tags.join("/"), taggedById(1), taggedById(3)?.tags.length);
console.log(taggedById(2) === novel, taggedById(9), shelf.find(isTagged) === novel);
console.log(shelf.findLast(isTagged) === diary, shelf.findLast((item): item is Tagged => "tags" in item)?.id);
console.log(shelf.filter(isTagged).length, shelf.filter(isTagged)[1] === diary);
console.log(
  shelf.findIndex((item): item is Tagged => "tags" in item),
  shelf.some((item): item is Tagged => "tags" in item),
  shelf.every((item): item is Tagged => "tags" in item),
);

// The found element is the element: a write through it is seen by every
// other holder, and a Map keyed by it counts one object.
const found = taggedById(3);
found?.tags.push("private");
console.log(diary.tags.join("/"), shelf.findLast(isTagged)?.tags.length);
const borrowed = new Map<Tagged, number>();
for (const id of [2, 3, 2, 9, 2]) {
  const book = taggedById(id);
  if (book) borrowed.set(book, (borrowed.get(book) ?? 0) + 1);
}
console.log(borrowed.size, borrowed.get(novel), borrowed.get(diary));

// A list that may hold nothing at a position: the search skips it.
const gaps: Array<Book | Tagged | undefined> = [undefined, atlas, novel, undefined];
const last = gaps.findLast((item): item is Tagged => item !== undefined && "tags" in item);
console.log(last === novel, gaps.find((item): item is Tagged => item !== undefined && item.id === 9 && "tags" in item));

// Class instances: the predicate names a subclass, and the search answers
// the instance.
abstract class Vessel {
  abstract litres(): number;
}
class Jug extends Vessel {
  readonly height: number;
  constructor(height: number) {
    super();
    this.height = height;
  }
  litres(): number {
    return this.height * 2;
  }
}
class Crate extends Vessel {
  readonly bottles: number;
  constructor(bottles: number) {
    super();
    this.bottles = bottles;
  }
  litres(): number {
    return this.bottles;
  }
}
const jug = new Jug(3);
const store: ReadonlyArray<Vessel> = [new Crate(6), jug, new Crate(12)];
function isJug(vessel: Vessel): vessel is Jug {
  return vessel instanceof Jug;
}
console.log(store.find(isJug) === jug, store.findLast(isJug)?.height, store.find(isJug)?.litres());
console.log(store.find((vessel): vessel is Crate => vessel instanceof Crate && vessel.bottles > 6)?.bottles);

// A tuple searched by position type.
const mixed: [string, Jug, number] = ["label", jug, 4];
console.log(mixed.find((part): part is Jug => part instanceof Jug) === jug, mixed.find((part): part is string => typeof part === "string"));
