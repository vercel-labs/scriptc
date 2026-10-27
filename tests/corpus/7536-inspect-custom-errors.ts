// [util.inspect.custom] on Error subclasses: console.log, util.inspect and
// %O call the method for typed values, values held as unknown and errors
// inside containers; a subclass without its own method inherits it, and
// errors without one print as before.
import * as util from "node:util";

class Tagged extends Error {
  [util.inspect.custom](depth: number): string {
    return `Tagged<${this.message}> at depth ${depth}`;
  }
}
class Nested extends Tagged {}
class Plain extends Error {}

const tagged = new Tagged("a");
console.log(tagged);
console.log(util.inspect(tagged), util.format("%O", new Nested("b")));
const held: unknown = new Nested("c");
console.log(held);
const list: unknown[] = [tagged, { inner: new Tagged("d") }];
console.log(list);
const plain: unknown = new Plain("plain");
console.log(String(plain), plain instanceof Error);
