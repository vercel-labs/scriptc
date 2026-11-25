// A constructor that reads a field through a pending argument and keeps the
// result across a write that frees the subtree: the class must keep its
// reference count, so the alias stays a valid reference and the program
// terminates with Node's answer.
class Node {
  left: Node | null;
  right: Node | null;
  constructor(arg: Node | null) {
    if (arg === null) {
      this.left = null;
      this.right = null;
      return;
    }
    const saved = arg.left;
    this.left = arg;
    this.right = null;
    this.left = null;
    if (saved !== null) console.log("saved right:", saved.right === null);
  }
}

function main(): void {
  const leaf = new Node(null);
  const child = new Node(leaf);
  const parent = new Node(child);
  console.log("parent left:", parent.left === null);
}

main();
