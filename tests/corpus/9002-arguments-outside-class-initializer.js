// ContainsArguments rejects `arguments` in a class field initializer and a
// class static block, and nowhere else: a method's own arguments and a
// function expression's are ordinary JavaScript.
class Box {
  static named = "named";
  field = function () {
    return arguments.length;
  };
  method() {
    return arguments.length;
  }
  arrow = () => this.method(1, 2);
}
const box = new Box();
console.log(box.field(1, 2, 3), box.method(4, 5), box.arrow());
