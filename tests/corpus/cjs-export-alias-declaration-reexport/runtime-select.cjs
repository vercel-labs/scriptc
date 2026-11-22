'use strict';
// react/jsx-runtime's shape: the whole export is one of two builds,
// chosen when the module runs.
if (process.env.CJS_ALIAS_DEMO_BUILD === "development") {
  module.exports = require("./runtime-development.cjs");
} else {
  module.exports = require("./runtime-production.cjs");
}
