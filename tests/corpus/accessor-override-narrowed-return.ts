// A subclass getter that narrows its base getter's union type (as lib.dom's
// ownerDocument narrows Node's Document | null to Document on Element):
// virtual reads through the base see the override, and reads through the
// subclass see the narrower type, as in Node.
class Doc { title = "doc"; }
const doc = new Doc();
class Node {
  get ownerDocument(): Doc | null { return null; }
  get parentLabel(): string | number | undefined { return undefined; }
  describe(): string { return this.ownerDocument === null ? "detached" : this.ownerDocument.title; }
}
class Element extends Node {
  get ownerDocument(): Doc { return doc; }
  get parentLabel(): string | number { return 3; }
}
class Text extends Node {}
const nodes: Node[] = [new Node(), new Element(), new Text()];
console.log(nodes.map((n) => n.describe()).join(","));
const el = new Element();
console.log(el.ownerDocument.title, el.parentLabel, typeof el.parentLabel);
const asNode: Node = el;
console.log(asNode.ownerDocument?.title, asNode.parentLabel);
const dynamic: any = el;
console.log(dynamic.ownerDocument.title, dynamic.parentLabel);
function title(e: Element): string { return e.ownerDocument.title.toUpperCase(); }
console.log(title(el));

// A getter narrowed to a subclass of its base getter's class.
class Animal { tag: string = "animal"; }
class Dog extends Animal { breed: string = "lab"; }
class Kennel {
  _a: Animal = new Animal();
  get pet(): Animal { return this._a; }
  describe(): string { return this.pet.tag; }
}
class DogKennel extends Kennel {
  get pet(): Dog { return new Dog(); }
}
const k = new DogKennel();
console.log(k.pet.breed, k.pet.tag, k.describe(), new Kennel().describe());
const base: Kennel = k;
console.log(base.pet.tag, base.pet instanceof Dog, (base.pet as Dog).breed);
