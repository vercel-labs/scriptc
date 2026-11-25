// An overload that names a subclass of the class its implementation
// returns, as DOM factories declare (`createElement("canvas")` as the canvas
// element class): the call's value is the subclass instance the
// implementation made, with the subclass's members.
class Base {
  a = 1;
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
}
class Leaf extends Base {
  c = 2;
  b(): string {
    return "leaf " + this.tag + this.c;
  }
}

function make(tag: "leaf"): Leaf;
function make(tag: string): Base;
function make(tag: string): Base {
  return tag === "leaf" ? new Leaf(tag) : new Base(tag);
}

const v = make("leaf");
console.log(v.a, v.b(), v instanceof Leaf);
const w = make("other");
console.log(w.a, w.tag, w instanceof Leaf);
console.log((make("leaf") as Leaf).b());

class Doc {
  create(tag: "canvas"): Leaf;
  create(tag: string): Base;
  create(tag: string): Base {
    return tag === "canvas" ? new Leaf(tag) : new Base(tag);
  }
}
const doc = new Doc();
const canvas = doc.create("canvas");
console.log(canvas.b(), canvas.c, doc.create("div").tag);
