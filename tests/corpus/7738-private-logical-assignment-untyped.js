// Logical assignments to a private field of another instance whose type
// JavaScript leaves open, the way a router trie numbers its parameter
// nodes on first use (`next.#varIndex ??= context.varIndex++`). They read
// and write the brand-checked field, and evaluate the right side only
// when they store it.
class Node {
  #varIndex;
  #label = "";
  #count = 0;
  #children = Object.create(null);

  child(key, context) {
    let next = this.#children[key];
    if (!next) next = this.#children[key] = new Node();
    next.#varIndex ??= context.varIndex++;
    next.#label ||= `node:${key}`;
    next.#count &&= next.#count + 1;
    next.#count ||= 1;
    return next;
  }

  describe() {
    const kind = typeof this.#varIndex === "number" ? "param" : "static";
    return `${kind} ${this.#varIndex} ${this.#label} ${this.#count}`;
  }

  static reset(node, other) {
    other.#label &&= "";
    other.#varIndex ??= -1;
    return [node.#label, other.#label, other.#varIndex];
  }

  static peek(value) {
    return value.#varIndex ??= 99;
  }
}

const context = { varIndex: 0 };
const root = new Node();
const a = root.child("a", context);
const b = root.child("b", context);
const again = root.child("a", context);
console.log(a === again, context.varIndex);
console.log(root.describe());
console.log(a.describe());
console.log(b.describe());
console.log(JSON.stringify(Node.reset(root, a)));
console.log(a.describe());

for (const value of [{}, null]) {
  try {
    Node.peek(value);
  } catch (error) {
    console.log(error instanceof TypeError, error.message);
  }
}
