// `exports.ESM = esm` publishes the ES module's namespace object itself, the
// same object requiring the module directly answers.
var esm = require("./esm.mjs");
exports.ESM = esm;
