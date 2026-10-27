// Export tables with method entries, accessors and spreads of required
// modules: the spread evaluates its module at its place in the table.
console.log("main: start");
const m = require("./lib.js");
console.log(m.scale(2), m.chars(true), m.chars(false), m.label, m.extra(), m.k);
