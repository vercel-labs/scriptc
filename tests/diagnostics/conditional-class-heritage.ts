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
