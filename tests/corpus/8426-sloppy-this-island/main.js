// @requires-libnode
// In a sloppy plain call `this` is the global object, never undefined: a
// user module that observes it runs in a Node island (decision S2's
// conservative marker islandizes the module, the engine decides the value).
// The functions are called through destructured bindings, so every call
// site here is plain.
const { isGlobal, plain, viaCall, viaApply, bound, arrow } = require("./receivers.js");

console.log(isGlobal(), plain(), viaCall(), viaApply(), bound(), arrow());
