// A class with static fields whose getter names a subclass declared later
// in the same module.
export class Node {
  static readonly ELEMENT_NODE = 1;
  static readonly TEXT_NODE = 3;
  parentNode: Node | null = null;
  get parentElement(): Element | null {
    const p = this.parentNode;
    return p instanceof Element ? p : null;
  }
}
export class Element extends Node {
  static readonly tag = "element";
}
