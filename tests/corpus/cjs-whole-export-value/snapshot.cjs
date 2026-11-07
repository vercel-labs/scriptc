// `module.exports = <binding>` stores the value the binding holds at the
// statement; a later write to the binding does not reach the export.
var current = function first() {
  return 1;
};
module.exports = current;
current = function second() {
  return 2;
};
