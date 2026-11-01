"use strict";

// A single-value whole export: `module.exports = instance` names a local
// instead of writing an export table, exactly highlight.js's `var highlight
// = HLJS({}); module.exports = highlight`.
function make(seed) {
  return {
    seed: seed,
    read: function () {
      return this.seed + 1;
    },
  };
}

var instance = make(41);

module.exports = instance;
