// ContainsArguments: a class field initializer and a class static block may
// not mention `arguments` (an arrow function's body is part of the
// initializer's own evaluation; a computed field name is not). The checker
// reports the spelling as TS2304, which JavaScript sources relax (an
// undeclared name is a runtime ReferenceError), so the early-error pass
// restores the spec's rejection.
class Box {
  value = (() => arguments);
  static {
    read(arguments);
  }
}
function read(value) {
  return value;
}
new Box();
