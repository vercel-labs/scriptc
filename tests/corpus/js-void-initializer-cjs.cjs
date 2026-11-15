// A CommonJS module in the transpiler's spelling: `void 0` declarators beside
// requires in one statement, and exports written from them.
var path = require("node:path"), result = void 0, attempts = 0, util = require("node:util");

function attempt(fn) {
  var value = void 0, error = void 0;
  attempts += 1;
  try {
    value = fn(attempts);
  } catch (err) {
    error = err;
  }
  return error === void 0 ? { ok: true, value: value } : { ok: false, message: error.message };
}

result = attempt(function (n) { return path.basename("/tmp/file-" + n + ".txt"); });
console.log(util.inspect(result));
result = attempt(function () { throw new TypeError("bad input"); });
console.log(util.inspect(result));
result = attempt(function (n) { return n * 2; });
console.log(result.ok, result.value, attempts);

exports.last = void 0;
exports.last = result;
console.log(typeof exports.last, module.exports.last.value);
