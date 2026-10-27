// In a generic function, `node instanceof Identifier || node instanceof
// PrivateIdentifier` narrows `node` to `T & PrivateIdentifier`: Identifier
// has every member PrivateIdentifier has, so TypeScript reduces the union of
// the two intersections to one. The narrowed read still holds either class,
// as in Node, when it is stored, read or called.
abstract class Node {
  kind: number;
  constructor(kind: number) {
    this.kind = kind;
  }
}
class Identifier extends Node {
  text: string;
  flow: number | undefined;
  constructor(text: string) {
    super(1);
    this.text = text;
    this.flow = undefined;
  }
  describe(): string {
    return `identifier ${this.text}`;
  }
}
class PrivateIdentifier extends Node {
  text: string;
  constructor(text: string) {
    super(2);
    this.text = text;
  }
  describe(): string {
    return `private ${this.text}`;
  }
}
class Keyword extends Node {
  constructor() {
    super(3);
  }
}

const names = new Map<Node, string>();

function clone<T extends Node>(node: T, copy: T): T {
  if (node instanceof Identifier || node instanceof PrivateIdentifier) {
    const name = names.get(node);
    if (name !== undefined) names.set(copy, name + "'");
  }
  return copy;
}

function label<T extends Node>(node: T): string {
  if (node instanceof Identifier || node instanceof PrivateIdentifier)
    return `${node.kind} ${node.text} (${node.describe()})`;
  return `${node.kind} -`;
}

// One instanceof test names one class.
function privateText<T extends Node>(node: T): string {
  if (node instanceof PrivateIdentifier) return node.text;
  return "-";
}

const id = new Identifier("a");
const hash = new PrivateIdentifier("#b");
const keyword = new Keyword();
const asNode: Node = id;
names.set(id, "A");
names.set(hash, "B");

console.log(names.get(clone(id, new Identifier("a2"))));
console.log(names.get(clone(hash, new PrivateIdentifier("#b2"))));
console.log(names.get(clone(asNode, new Identifier("a3"))));
console.log(names.get(clone<Node>(hash, new PrivateIdentifier("#b3"))));
console.log(names.get(clone<Node>(keyword, new Keyword())));
console.log(names.size);

for (const node of [id, hash, keyword] as Node[]) console.log(label(node));
console.log(label(id), "|", label(hash));
console.log(privateText<Node>(id), privateText<Node>(hash), privateText(hash));
