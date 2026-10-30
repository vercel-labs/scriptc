// ContainsArguments: a class field initializer and a static block body may not
// reference `arguments` (the static semantics behind SC0008). The restriction
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
