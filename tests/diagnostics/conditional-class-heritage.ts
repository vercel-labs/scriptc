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
