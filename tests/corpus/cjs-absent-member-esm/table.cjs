'use strict';

// `later` is a name Node's lexer detects (so a named import links), but the
// branch never runs, so the exports object does not carry it.
exports.present = 42;
if (false) exports.later = 'set';
