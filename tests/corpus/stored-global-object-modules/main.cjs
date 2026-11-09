// The global object stored in one module and read by name in others: every
// read answers the value the bare name reads.
var root = require("./root.cjs");
var reader = require("./reader.cjs");

// The receiver of a sloppy-mode function expression called in place is the
// global object.
var sloppy = (function () {
  var found = this;
  return { root: found, same: found === globalThis, json: found.JSON };
})();

console.log("same object:", root === globalThis, sloppy.same, sloppy.root === root);
console.log("URL:", reader.URLClass === URL, typeof reader.URLClass);
console.log("TextEncoder:", reader.encoder);
console.log("describe:", reader.describe(root));
console.log("describe sloppy:", reader.describe(sloppy.root));
console.log("JSON:", sloppy.json === JSON, sloppy.json.stringify({ a: [1] }));

// A holder object, an argument and a reassigned binding.
var holder = { g: root };
function pick(from, name) {
  return name === "Map" ? from.Map : from.Object;
}
console.log("field:", holder.g.Array === Array, holder.g.Error === Error);
console.log("argument:", pick(holder.g, "Map") === Map, pick(root, "Object") === Object);
var later;
later = globalThis;
console.log("assigned:", later.Math === Math, later.parseInt("7") + 1);

// A property set through one holder reads back through the others.
root.shared = "set";
console.log("own:", sloppy.root.shared, later.shared, typeof holder.g.unset);
