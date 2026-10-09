// Array callbacks receive present elements unless the array can hold an
// explicit undefined value (or a hole, for the find family). Callees keep
// working for both, and every element that is undefined in JavaScript is
// still undefined natively.
class Tag {
  label: string;
  constructor(label: string) {
    this.label = label;
  }
}

function name(tag: Tag): string {
  return tag === undefined ? "<none>" : tag.label;
}

function annotate(tag: Tag): Tag {
  name(tag);
  return tag;
}

// Dense arrays built from present values.
const dense: Tag[] = [new Tag("a"), new Tag("b")];
dense.push(new Tag("c"));
console.log(dense.map((tag) => name(annotate(tag))).join(","));
console.log(dense.some((tag) => name(tag) === "b"), dense.every((tag) => name(tag) !== ""));
console.log(dense.filter((tag) => name(tag) !== "a").length, dense.findIndex((tag) => name(tag) === "c"));
dense.forEach((tag, index) => console.log("dense", index, name(tag)));
console.log(dense.reduce((total, tag) => total + name(tag).length, 0));
console.log(dense.flatMap((tag) => [name(tag), name(tag)]).join(""));

// A store of an unchecked read can put undefined into another array.
const source: Tag[] = [new Tag("s")];
const mixed: Tag[] = [new Tag("m")];
mixed.push(source[3]);
mixed.forEach((tag, index) => console.log("mixed", index, name(tag)));
console.log(mixed.map((tag) => typeof tag).join(","));

// Holes are skipped by most callbacks but visited by the find family.
const sparse: Tag[] = [new Tag("x")];
sparse[3] = new Tag("y");
sparse.forEach((tag, index) => console.log("sparse", index, name(tag)));
console.log(
  sparse.find((tag): boolean => tag === undefined) === undefined,
  sparse.findIndex((tag) => tag === undefined),
);
console.log(sparse.findLastIndex((tag) => name(tag) === "<none>"));

// Copies turn holes into explicit undefined values.
const spread = [...sparse];
spread.forEach((tag, index) => console.log("spread", index, name(tag)));
const copied: Tag[] = [];
for (const tag of sparse) copied.push(tag);
console.log(copied.map((tag) => name(tag)).join("|"));
const [head, ...rest] = sparse;
console.log(name(head), rest.map((tag) => name(tag)).join("|"));
console.log(Array.from(sparse).filter((tag): boolean => tag === undefined).length);

// A local array that only its own scope touches keeps its holes to itself.
function slots(count: number): string {
  const table = new Array<Tag>(count);
  table[count - 1] = new Tag("end");
  let text = "";
  for (let i = 0; i < table.length; i++) {
    const tag = table[i];
    text += tag === undefined ? "." : name(tag);
  }
  return text;
}
console.log(slots(4));

// A private cache with holes; its entries are read only by index.
class Registry {
  private readonly entries: Tag[];
  constructor(size: number) {
    this.entries = new Array<Tag>(size);
  }
  get(index: number): Tag {
    if (Object.hasOwn(this.entries, index)) return this.entries[index]!;
    const tag = new Tag(`t${index}`);
    this.entries[index] = tag;
    return tag;
  }
  get size(): number {
    return this.entries.length;
  }
}
const registry = new Registry(5);
const picked = [registry.get(3), registry.get(1), registry.get(3)];
console.log(picked.map((tag) => name(tag)).join(","), registry.size);

// An undefined value cast into the element type and filled in.
function amount(value: number): string {
  return value === undefined ? "<none>" : String(value);
}
const filled: number[] = [1, 2, 3];
filled.fill(undefined as unknown as number, 1, 2);
filled.forEach((value, index) => console.log("filled", index, amount(value)));

// Callbacks returning an unchecked read build arrays holding undefined.
const indexes = [0, 5];
const looked = indexes.map((index) => dense[index]);
looked.forEach((tag, index) => console.log("looked", index, name(tag)));

// Rest parameters receive absent arguments as undefined elements.
function labels(...tags: Tag[]): string {
  return tags.map((tag) => name(tag)).join("+");
}
console.log(labels(dense[0]!, source[9], dense[1]!));

// Regular expression groups that do not participate are undefined.
const groups = "ab".match(/(a)(x)?(b)/)!;
console.log(groups.map((group) => (group === undefined ? "-" : group)).join(""));

// Spreading present callback elements initializes every field.
const rows = [{ name: "row", id: 1 }].slice();
const labeled = rows.map((row) => ({ ...row, label: "copy" }));
console.log(labeled.length, labeled[0]!.label, labeled[0]!.id);

// Truncating keeps the remaining elements present.
const trimmed: Tag[] = [new Tag("p"), new Tag("q"), new Tag("r")];
trimmed.length = trimmed.length - 1;
console.log(trimmed.map((tag) => name(tag)).join(","));
