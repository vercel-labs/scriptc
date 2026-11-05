// The CommonJS exporter: a module.exports TABLE with shorthand entries
// (alias plumbing), an expression-valued entry (its own export global),
// and a plain const entry.
'use strict';

function double(n) {
  return n * 2;
}

const VERSION = "1.2.3";

module.exports = {
  double,
  VERSION,
  bump: (x) => x + 1,
  label: "lib",
};
