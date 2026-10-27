// A method of a function-local class that never reads `this` keeps working
// when it is taken off an instance and called detached or with another
// receiver.
function make(label: string) {
  class Box {
    one(): number {
      return 1;
    }

    named(): string {
      return `box ${label}`;
    }
  }
  return new Box();
}

const box = make("a");
const one = box.one;
console.log(one(), box.one.call(null), box.one.call({}), box.named());
