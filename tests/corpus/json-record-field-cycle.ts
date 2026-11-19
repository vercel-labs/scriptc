// A class field holding a cyclic record: JSON.stringify throws Node's
// catchable TypeError instead of trapping or silently truncating the copy.
interface NodeRec {
  id: number;
  next?: NodeRec;
}

class Box {
  node: NodeRec;
  constructor(node: NodeRec) {
    this.node = node;
  }
}

const a: NodeRec = { id: 1 };
const b: NodeRec = { id: 2, next: a };
a.next = b;
try {
  console.log(JSON.stringify(new Box(a)));
} catch (error) {
  console.log(
    error instanceof Error ? `${error.name}: ${error.message.split("\n")[0]}` : typeof error,
  );
}

// A recursive index-signature record reaches the same TypeError: its values
// are written through the type-directed writer, not copied.
interface Bag {
  [key: string]: Bag | undefined;
}

class Bags {
  bag: Bag;
  constructor(bag: Bag) {
    this.bag = bag;
  }
}

const bag: Bag = {};
bag["self"] = bag;
try {
  console.log(JSON.stringify(new Bags(bag)));
} catch (error) {
  console.log(
    error instanceof Error ? `${error.name}: ${error.message.split("\n")[0]}` : typeof error,
  );
}
