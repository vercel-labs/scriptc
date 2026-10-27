// Inspecting an Error subclass instance renders its header from the
// instance's own name and message. A program class that declares a `name`,
// `message` or `stack` accessor changes what Node reads, so inspecting the
// hierarchy has no lowering.
import * as util from "node:util";

class Named extends Error {
  override get name(): string {
    return "Custom";
  }
}
class Deeper extends Named {}

console.log(util.inspect(new Named("accessor")));
console.log(new Deeper("inherited accessor"));
