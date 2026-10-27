// A write to a prototype's `name` changes the header Node prints for an
// Error subclass instance, which renders from the instance's own name, so
// inspecting a program-declared Error subclass has no lowering.
import * as util from "node:util";

class Prototyped extends Error {}
Prototyped.prototype.name = "PrototypedError";

console.log(util.inspect(new Prototyped("prototype name")));
