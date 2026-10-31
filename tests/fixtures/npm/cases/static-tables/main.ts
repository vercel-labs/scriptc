// Constant function tables, primitive members and a constructor function in
// namespace-style packages, used from TypeScript (js-main.cjs is the
// JavaScript consumer).
import { lib } from "static-tables";

let total = 0;
for (let i = 0; i < 50; i++) {
  total += lib.apply("add", i, 1) + lib.apply("mul", i, 2) - lib.apply("sub", i, 3);
}
console.log(total);
console.log(lib.Mode.OFF, lib.Mode.ON, lib.Mode.LABEL, lib.Mode.NEG, lib.describe(1), lib.describe(0));
console.log(lib.read("get"), lib.dispatch("a"), lib.pick(1));
lib.register("b", () => "b!");
console.log(lib.dispatch("b"), lib.limit());
lib.bump();
console.log(lib.limit(), new lib.Pair(2, 3).sum(), lib.inits());
