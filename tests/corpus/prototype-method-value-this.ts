// A class's prototype method replaced on the prototype object runs for
// every instance, including instances created before the replacement, and a
// wrapper with its own `this` forwards the receiver it is called with.
// mock.method on the prototype replaces the method for all instances,
// records each calling instance as its `this`, and restore gives the
// declared method back.
import { mock } from "node:test";

class Greeter {
  greeting: string;
  constructor(greeting: string) {
    this.greeting = greeting;
  }
  greet(name: string): string {
    return `${this.greeting} ${name}`;
  }
}

const early = new Greeter("hi");
const original = Greeter.prototype.greet;
console.log(early.greet("bob"), Greeter.prototype.greet.call(new Greeter("yo"), "ann"));
Greeter.prototype.greet = function (this: Greeter, name: string) {
  return `[${original.call(this, name)}]`;
};
console.log(early.greet("x"), new Greeter("hey").greet("y"));
const m = mock.method(Greeter.prototype, "greet", function (this: Greeter, name: string) {
  return `mock(${name})`;
});
const late = new Greeter("late");
console.log(late.greet("z"), early.greet("w"), m.mock.callCount());
console.log(m.mock.calls[0]!.this === late);
m.mock.restore();
console.log(early.greet("q"), new Greeter("new").greet("r"));
