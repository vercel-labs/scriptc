// Function-local class expressions that refer to themselves by their own name.
function counter(start: number) {
  const C = class Counter {
    value: number;
    constructor(value: number) { this.value = value; }
    next(): Counter { return new Counter(this.value + 1); }
    static first(): Counter { return new Counter(start); }
    static isSelf(value: unknown): boolean { return value === Counter; }
  };
  return C;
}
const Counter1 = counter(10);
console.log(Counter1.first().next().next().value);
console.log(Counter1.isSelf(Counter1), Counter1.isSelf(counter(1)), Counter1.name);

function box<T>(seed: T) {
  return class Box {
    value: T;
    constructor(value: T) { this.value = value; }
    again(): Box { return new Box(this.value); }
    static of(): Box { return new Box(seed); }
  };
}
const StringBox = box("seed");
console.log(new StringBox("x").again().value, StringBox.of().value);
const NumberBox = box(7);
console.log(NumberBox.of().again().value + 1);

function nested(n: number) {
  const Outer = class Tree {
    children: Tree[] = [];
    static build(depth: number): Tree {
      const tree = new Tree();
      if (depth > 0) tree.children.push(Tree.build(depth - 1), Tree.build(depth - 1));
      return tree;
    }
    size(): number { return 1 + this.children.reduce((total, child) => total + child.size(), 0); }
  };
  return Outer.build(n).size();
}
console.log(nested(3));

// The only reference to the name is a shorthand property.
function registry(tag: string) {
  return class Entry {
    readonly tag = tag;
    static table(): Record<string, unknown> {
      return { Entry };
    }
  };
}
const Entry1 = registry("e");
console.log(Entry1.table().Entry === Entry1, new Entry1().tag);
