// @requires-libnode
// A statement that hands the island a function of the program is not
// island-closed: it is lowered call by call, and Node starts there. The
// closed statements after it evaluate where they stand, and the island
// calls the program's function during each, as in Node.
import { alpha, beta, registry } from "plug-kit";

const seen: string[] = [];
registry.onRegister((name: string) => {
  seen.push(name);
  console.log("registered", name, seen.length);
});
registry.register("alpha", alpha);
console.log("between", seen.join("+"));
registry.register("beta", beta);
console.log("after", seen.join("+"), registry.count());
