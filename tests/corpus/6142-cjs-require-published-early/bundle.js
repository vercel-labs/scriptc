'use strict';

// The esbuild CommonJS layout: stored class expressions and the export
// table come before the var requires their methods use. Publishing the
// classes runs none of their methods.
const Provider = class {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
  }
  describe() {
    return core.label(this.name);
  }
};
const REASON = 'default';
module.exports = { Provider, REASON };
var core = require('./core.js');
