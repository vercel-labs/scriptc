const first = require("./named.cjs");
const second = require("./anonymous.cjs");
const third = require("./arrow.cjs");
const fourth = require("./bound.cjs");
const Fifth = require("./klass.cjs");

exports.viaRequire = function () {
  return [first.name, second.name, third.name, fourth.name, Fifth.name, first === require("./named.cjs")];
};
