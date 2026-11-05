// @requires-libnode
// A native subclass of a deferred island class, created lazily (scope-B
// NI-5d), thrown after the program ran without Node for a while: the throw
// creates the class through the island base, and instanceof holds on both
// sides, including the builtin Error.
import { isKitError, KitError } from "errkit";

class BuildError extends KitError {
  hint = "retry";
  constructor(message: string) {
    super({ code: "BUILD", message });
  }
  describe(): string {
    return `${this.code}: ${this.message} (${this.hint})`;
  }
}

console.log("start", typeof BuildError, BuildError.name);
console.log("instanceof before", ({}) instanceof BuildError);
function build(step: number): void {
  if (step === 3) throw new BuildError(`step ${step} failed`);
  console.log("step", step);
}
try {
  for (let i = 1; i <= 4; i++) build(i);
} catch (e) {
  if (e instanceof BuildError) console.log("caught", e.describe());
  console.log("checks", e instanceof KitError, e instanceof Error, isKitError(e));
  if (e instanceof Error) console.log("message", e.message, e.name);
}
const second = new BuildError("again");
console.log("second", second instanceof BuildError, second.code, BuildError.name);
