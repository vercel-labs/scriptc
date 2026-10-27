const status = require("./status.cjs");
exports.describe = function (code) {
  return code + " " + status.message[code];
};
