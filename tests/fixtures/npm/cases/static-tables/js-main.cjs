// The JavaScript consumer of static-tables
// (tests/harness/static-tables.test.ts compiles it with the shape overlay on).
const { lib } = require("static-tables");

let total = 0;
for (let i = 0; i < 50; i++) {
  total += lib.apply("add", i, 1) + lib.apply("mul", i, 2) - lib.apply("sub", i, 3);
}
console.log(total);
console.log(lib.Mode.OFF, lib.Mode.ON, lib.Mode.LABEL, lib.Mode.NEG, lib.describe(1), lib.describe(0));
console.log(lib.read("get"), lib.dispatch("a"), lib.pick(1));
lib.register("b", function () {
  return "b!";
});
console.log(lib.dispatch("b"), lib.limit());
lib.bump();
console.log(lib.limit(), new lib.Pair(2, 3).sum(), lib.inits());
try {
  lib.apply("missing", 1, 2);
} catch (e) {
  console.log(e instanceof TypeError);
}
for (const holder of lib.holders) {
  for (const read of [() => lib.modeOn(holder), () => lib.addVia(holder), () => lib.callVia(holder, "mul")]) {
    try {
      console.log(read());
    } catch (e) {
      console.log(e.constructor.name, e.message);
    }
  }
}
