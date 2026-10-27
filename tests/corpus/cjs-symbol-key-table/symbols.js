// The key table: one module exports every symbol its siblings use as
// class keys (undici's core/symbols.js). Each property names one symbol
// identity for all requirers.
'use strict';

module.exports = {
  kState: Symbol('state'),
  kSize: Symbol('size'),
  kName: Symbol('name'),
  kRun: Symbol('run'),
};
