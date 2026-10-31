// A [util.inspect.custom] method that throws inside an outer inspect: an
// enclosing custom method that catches the error, and the walk around it,
// continue with their own indentation and colors.
const util = require("node:util");
class Throws {
  [util.inspect.custom]() {
    throw new Error("inner");
  }
}
class Catches {
  [util.inspect.custom]() {
    let note = "";
    try {
      note = util.inspect({ a: { b: [new Throws()] } });
    } catch (e) {
      note = "caught " + e.message;
    }
    return note + " then " + util.inspect({ x: { y: [1, 2] } });
  }
}
const shared = { k: 1 };
const outer = { first: { deep: new Catches() }, list: [new Catches(), { z: 3 }], s: shared, t: shared };
console.log(util.inspect(outer, { breakLength: 50 }));
console.log(JSON.stringify(util.inspect([new Catches(), "s"], { colors: true })));
try {
  console.log(util.inspect({ a: { b: new Throws() } }));
} catch (e) {
  console.log("outer caught", e.message);
}
console.log({ after: { deep: { x: 1 } }, list: [1, 2, 3] });
