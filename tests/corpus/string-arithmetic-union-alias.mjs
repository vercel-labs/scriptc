// A binding that copies an unchecked string-arithmetic result holds the same
// run-time union, whatever the checker types the copy from: formatting it,
// or asking its `typeof`, must not narrow it to the string arm the
// initializer names, because the value can be the number arm (NaN) there.
/** @param {string} [text] */
function direct(text) {
  /** @type {string | number} */
  const sum = text + 1;
  /** @type {string | number} */
  const alias = sum;
  console.log(typeof alias, alias);
}
direct();
direct("a");

// An alias of an alias keeps the union too.
/** @param {string} [text] */
function chained(text) {
  /** @type {string | number} */
  const sum = text + 1;
  const first = sum;
  /** @type {string | number} */
  const second = first;
  console.log(`${second}`, typeof second);
}
chained();
chained("a");

// A copy under a cast keeps it as well.
/** @param {string} [text] */
function casted(text) {
  /** @type {string | number} */
  const sum = text + 1;
  const copy = sum;
  console.log(`${copy}`, typeof copy);
}
casted();
casted("b");
