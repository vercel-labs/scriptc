// @exit: 1
// A wrapper that returns a class still evaluates the class's static
// initializer when it is called, so the callback's later binding throws.
function wrap(read) {
  return class {
    static total = read();
    count() {
      return read();
    }
  };
}
console.log("before");
const Made = wrap(() => budget);
const budget = 9;
console.log(Made.total);
