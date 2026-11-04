// ContainsArguments: a class field initializer and a static block body may not
// reference `arguments` (the static semantics behind SC0011). The restriction
// follows arrow functions, which have no `arguments` of their own, and stops
// at every ordinary function body, which binds one — Node accepts the last
// field and throws a SyntaxError for the other three.
class Fields {
  direct = arguments;
  fromArrow = () => arguments;
  static {
    const fromBlock = () => arguments;
  }
  legal = function () {
    return arguments.length;
  };
}

// A DESTRUCTURED property named `arguments` is not a reference: `{ arguments:
// a }` names the property and binds `a`, which Node accepts in both places.
class Destructured {
  field = (() => {
    const { arguments: fieldLocal } = { arguments: 5 };
    return fieldLocal;
  })();
  static {
    const { arguments: blockLocal } = { arguments: 7 };
    console.log(blockLocal);
  }
}

// An ACCESSOR named `arguments` names a property too.
class Accessors {
  field = {
    get arguments() {
      return 1;
    },
    set arguments(v) {
      this.seen = v;
    },
  }.arguments;
}
