// A method that never reads `this`, taken off an instance of a class
// declared inside a function: the detached method runs without a receiver.
function helper(): string {
  return "helper";
}
function make() {
  return class Local {
    tag = "t";
    plain(): string {
      return helper();
    }
  };
}
const C = make();
const detached = new C().plain;
console.log(detached());
