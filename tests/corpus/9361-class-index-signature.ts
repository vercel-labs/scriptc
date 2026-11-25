// A class index signature declares no storage: JavaScript emits nothing for
// it. A name the class does not declare is an ordinary own property of the
// instance, created by the first write and absent before it, and it is the
// same property through every view of the instance.
class Bag {
  size: number;
  [key: string]: unknown;
  constructor(size: number, extra: Record<string, unknown>) {
    this.size = size;
    for (const name of Object.keys(extra)) this[name] = extra[name];
  }
  describe(): string {
    return `bag of ${this.size} (${String(this.color)})`;
  }
}

const bag = new Bag(2, { color: "red", weight: 5 });
console.log(bag.size, bag.color, bag.weight, bag.missing);
console.log(bag.describe(), Object.keys(bag).join(","));
console.log("color" in bag, "size" in bag, "describe" in bag, "missing" in bag);

// Written after construction, by name and by computed key.
bag.late = true;
const key: string = "weight";
bag[key] = 6;
bag["quoted"] = "q";
console.log(bag.late, bag.weight, bag[key], bag.quoted, bag[key + "?"]);
console.log(Object.keys(bag).join(","), JSON.stringify(bag));

// A declared field keeps its slot whichever way it is named.
bag["size"] = 9;
const sizeKey: string = "size";
console.log(bag.size, bag[sizeKey]);

// The untyped view of the instance is the same object.
const view: any = bag;
view.viaView = 1;
console.log(bag.viaView, view.color, view === bag);

// A subclass inherits the signature: what it stores under names nobody
// declares, in its constructor or later, follows what the base constructor
// stored. An instance typed as the base answers for all of it.
class Tagged extends Bag {
  constructor(tag: string) {
    super(1, { fromBase: true });
    this.tag = tag;
    this.origin = "subclass";
  }
  label(): string {
    return `${String(this.tag)}/${String(this.origin)}`;
  }
}
const tagged = new Tagged("t");
tagged.note = "n";
const base: Bag = tagged;
console.log(tagged.tag, tagged.origin, tagged.note, tagged.label(), base.tag, base.note, base.absent);
console.log("tag" in base, "note" in base, "label" in base, "absent" in base, Object.keys(base).join(","));
console.log(base instanceof Tagged, JSON.stringify(tagged));

// Two instances do not share added properties.
const other = new Bag(0, {});
console.log(other.color, other.late, "late" in other, Object.keys(other).join(","));

// `any` and `unknown` signatures read the same way; `any` members chain.
class Loose {
  [key: string]: any;
}
const loose = new Loose();
loose.list = [1, 2, 3];
loose.nested = { depth: { value: "deep" } };
console.log(loose.list.length, loose.nested.depth.value, loose.absent?.anything, typeof loose.absent);

// A generic class with a signature.
class Box<T> {
  value: T;
  [key: string]: unknown;
  constructor(value: T) {
    this.value = value;
  }
}
const box = new Box(3);
box.unit = "px";
console.log(box.value + 1, box.unit, box.missing);
