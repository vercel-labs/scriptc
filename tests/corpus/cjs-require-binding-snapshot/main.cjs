// Reading a snapshot module through a re-export wrapper, a split require
// binding, and an inline require answers the value the export statement
// stored, never the binding's later value.
const viaWrapper = require("./wrapper.cjs");
console.log(viaWrapper.name, viaWrapper());

var split;
split = require("./snapshot.cjs");
console.log(split.name, split());

const inline = require("./snapshot.cjs");
console.log(inline.name, inline());
