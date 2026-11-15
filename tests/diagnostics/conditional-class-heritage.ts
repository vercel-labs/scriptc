// A heritage expression may choose its base at run time, but a class's
// instance layout is fixed where the class is lowered: two unrelated classes
// have no layout the subclass could take on both paths.
class Left {
  left = 1;
}
class Right {
  right = 2;
}

const pick = Math.random() < 0.5;

class Both extends (pick ? Left : Right) {
  own = 3;
}

const both = Both;
console.log(both.name);

// Related arms share a type, but the class still lays out as that one type:
// an arm that declares instance members of its own would have Node run its
// constructor, fields, and overrides when the conditional selects it.
class Base {
  base = 1;
}
class Sub extends Base {
  extra = 2;
}

class Narrow extends (pick ? Sub : Base) {
  own = 4;
}

const narrow = Narrow;
console.log(narrow.name);

// An `instanceof` test answers from the arm the conditional selected, but a
// value it proves to be an instance of that arm is still laid out, and
// dispatches, as the class it was built as: narrowing it to the arm is
// refused.
class Shape {
  area(): number {
    return 0;
  }
}
class Square extends Shape {}
class Tile extends (pick ? Square : Shape) {
  override area(): number {
    return 4;
  }
}
const shape: Shape = new Tile();
if (shape instanceof Square) console.log(shape.area());

// A nested conditional is typed as the class its arms share, which can be
// the outer typed class itself while an inner arm is a subclass with its own
// constructor, fields, and overrides. Node runs the selected leaf's
// initialization and dispatches its overrides, and only a single conditional
// records which class it selected, so a nested one that can select different
// classes is refused rather than laid out as the shared class.
class Leaf extends Shape {
  sides = 4;
  constructor() {
    super();
    console.log("Leaf constructor");
  }
  override area(): number {
    return 9;
  }
}
const inner = Math.random() < 0.5;
class Nested extends (pick ? Shape : (inner ? Leaf : Shape)) {
  own = 5;
}
const nested = Nested;
console.log(nested.name);

// A const bound to the inner conditional is the same nested choice.
const Inner = inner ? Leaf : Shape;
class Bound extends (pick ? Shape : Inner) {
  own = 6;
}
const bound = Bound;
console.log(bound.name);

// A static the selected arm redeclares over the typed class's is read
// through the derived class in Node; a read resolved against the typed
// class would answer the base's value instead.
class Named {
  static label = "named";
}
class Relabeled extends Named {
  static override label = "relabeled";
}
class Labeled extends (pick ? Relabeled : Named) {}
console.log(Labeled.label);
