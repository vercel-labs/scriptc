// Top-level `this` in a CommonJS module is module.exports (an object), also
// inside arrow functions at module scope.
const lib = require("./lib.js");
const self = this;
const arrow = () => this;
console.log(typeof this, self === this, arrow() === this, this ? "truthy" : "falsy");
console.log(lib.describe());
(function () {
  console.log("call(this):", typeof this);
}).call(this);
if ((typeof module !== "undefined" && module !== null) && module.exports) console.log("commonjs host");
else console.log("browser host");
