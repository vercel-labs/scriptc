// A hoisted `var` is `undefined` until its first assignment runs: Node reads
// the value, never a ReferenceError. The binding takes checked-dynamic
// storage so a read before the assignment answers `undefined` whatever
// branch later installs the value.

function optionalCallback(flag) {
  var callback;
  if (flag) callback = function () { return "called"; };
  return [callback && callback(), typeof callback];
}
console.log("optional", optionalCallback(true).join());
console.log("missing", optionalCallback(false).join());

function installLater() {
  var handler;
  var seen = [];
  seen.push(handler && handler());
  handler = function () { return "late"; };
  seen.push(handler && handler());
  return seen.join();
}
console.log("later", installLater());

function keyed() {
  var key;
  var table = {};
  table[key] = 1;
  key = "a";
  table[key] = 2;
  return Object.keys(table).join();
}
console.log("keyed", keyed());

function nested(flag) {
  var value;
  function read() {
    return typeof value;
  }
  if (flag) value = 7;
  return read() + ":" + value;
}
console.log("nested", nested(true), nested(false));
