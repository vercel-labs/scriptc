// A class with an index signature and fields of its own, below a base class
// whose constructor can add a property before those fields exist: Node lists
// the property before the fields, a compiled instance lists declared fields
// first, so the class is refused. Two ways the base constructor gets there
// without a call in its body:
// a default parameter that calls a method the subclass overrides,
class Parcel {
  label: string;
  constructor(label: string = this.stamp()) {
    this.label = label;
  }
  stamp(): string {
    return "plain";
  }
}
class Crate extends Parcel {
  [key: string]: unknown;
  first = 1;
  stamp(): string {
    this.early = true;
    return "crate";
  }
}
// a default inside a destructured parameter,
class Pallet {
  rows: number;
  constructor({ rows = Pallet.count() }: { rows?: number } = {}) {
    this.rows = rows;
  }
  static count(): number {
    return 4;
  }
}
class Stack extends Pallet {
  [key: string]: unknown;
  height = 2;
}
// and an assignment to a field declared with `declare`, which has no slot:
// the assignment creates the property.
class Envelope {
  declare note: string;
  constructor() {
    this.note = "fragile";
  }
}
class Folder extends Envelope {
  [key: string]: unknown;
  tabs = 3;
}
// The indexed class's own constructor runs after its fields exist: both
// forms compile there.
class Drawer {
  [key: string]: unknown;
  declare tag: string;
  depth = 5;
  constructor(count: number = this.mark()) {
    this.tag = "left";
    this.count = count;
  }
  mark(): number {
    this.early = true;
    return 7;
  }
}
const crate = new Crate();
const stack = new Stack();
const folder = new Folder();
const drawer = new Drawer();
console.log(crate.first, stack.height, folder.tabs, drawer.depth);
