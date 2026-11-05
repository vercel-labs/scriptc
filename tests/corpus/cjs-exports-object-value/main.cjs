// A module namespace used as a value: `exports.CST = cst` in index.cjs
// publishes the dependency's exports object. Requirers must see that one
// object — the same identity as requiring the dependency directly — with
// members read live as the dependency's own exports change.
const index = require("./index.cjs");
const parse = require("./parse.cjs");
const state = require("./state.cjs");

console.log("typeof:", typeof index.CST);
console.log("keys:", Object.keys(index.CST).join(","));
console.log("identity:", index.CST === parse, index.STATE === state);
console.log("call:", index.CST.parse("a").tag, index.CST.visit({ tag: "b" }));

// A member added to the dependency after the re-export is visible through
// the published object.
parse.late = "added";
console.log("late:", index.CST.late, Object.keys(index.CST).join(","));

// Export values are read live: the dependency's own later assignment shows
// through the published object.
console.log("before:", index.STATE.ready, state.ready);
state.mark();
console.log("after:", index.STATE.ready, state.ready);

// The module's own other exports stay ordinary values.
console.log("name:", index.name, typeof index.CST.parse);
