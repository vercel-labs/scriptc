// An arithmetic operand the checker types as a union of the operator's
// string and numeric forms (`name && name.indexOf(".")` is `"" | number`):
// the value the operand holds decides between addition and concatenation at
// run time, which is exactly what the checked-dynamic conversion applies.

/**
 * @param {string} name
 */
function suffix(name) {
  const lastDot = name && name.lastIndexOf(".");
  if (lastDot !== undefined && lastDot !== -1) return name.substring(lastDot + 1);
  return "";
}

console.log("suffix", JSON.stringify(suffix("a.b")), JSON.stringify(suffix("abc")), JSON.stringify(suffix("")));

/**
 * @param {number} n
 */
function sum(n) {
  const value = n > 0 ? "" : n;
  return value + 1;
}

console.log("sum", sum(2), sum(-1));

/**
 * @param {number} n
 */
function difference(n) {
  const value = n > 0 ? "" : n;
  return value - 1;
}

console.log("difference", difference(0), difference(5));

/**
 * @param {number} n
 */
function compare(n) {
  const value = n > 0 ? "" : n;
  return [value < 1, value > 1];
}

console.log("compare", compare(3).join(), compare(0).join());

/**
 * @param {string} label
 */
function wrap(label) {
  const value = label && label.length;
  return value && value + 1;
}

console.log("wrap", wrap("abc"), JSON.stringify(wrap("")));
