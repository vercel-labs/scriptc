// A module-level statement whose island call leaves a rejected promise
// behind. Node reports it unhandled when the turn that made it ends; a
// statement evaluated later, or never, would not. The build's probe sees
// the promise, so the statement stays where the program has it.
import { alpha, registry } from "plug-kit";

registry.register("alpha", alpha);
registry.failLater("not ready");
console.log("registered", registry.count());
