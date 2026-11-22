'use strict';
var KIND = Symbol.for("demo.kind");
var LABEL = "core label";
exports.Kind = KIND;
exports.label = LABEL;
exports.describe = function () {
  return "core describe";
};
