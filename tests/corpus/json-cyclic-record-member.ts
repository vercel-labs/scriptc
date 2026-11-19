// A recursive record that also carries an unknown index signature can hold a
// cycle through its fields or its checked-dynamic entries. JSON.stringify
// throws the catchable circular-structure TypeError for it at the root, as a
// member and in an array slot; it never ends the process. A repeated
// reference that does not close a cycle still serializes at every position.
interface Node {
  id: number;
  [key: string]: unknown;
  child?: Node;
}

function caught(value: () => string): string {
  try {
    return value();
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return `${error instanceof TypeError ? "TypeError" : "other"}: ${message}`;
  }
}

const self: Node = { id: 1 };
self.child = self;
console.log(caught(() => JSON.stringify(self)));
console.log(caught(() => JSON.stringify({ wrap: self })));
console.log(caught(() => JSON.stringify([self])));

// A shared reference that does not close a cycle serializes at each site.
const leaf: Node = { id: 3 };
const shared = { first: leaf, second: leaf };
console.log(JSON.stringify(shared));
console.log(JSON.stringify([leaf, leaf]));

// A cycle behind a non-cyclic prefix still throws with the prefix written.
const head: Node = { id: 4 };
const second: Node = { id: 5, child: head };
head.child = second;
console.log(caught(() => JSON.stringify(head)));
