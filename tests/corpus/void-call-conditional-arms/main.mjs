const log = [];
/** @returns {void} */
function f() {
  log.push("f");
  return "f-value";
}
/** @returns {void} */
function g() {
  log.push("g");
  return "g-value";
}
const flag = false;
flag ? f() : g();
(flag ? g() : f());
console.log(log.join(","));
