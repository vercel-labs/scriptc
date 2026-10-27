// @ts-check
let status = "unset";
try {
  require("scriptc-test-definitely-not-installed");
  status = "installed";
} catch (e) {
  status = "missing: " + e.code + " " + String(e.message).split("\n")[0];
}
exports.probe = function probe() { return status; };
