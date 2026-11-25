"use strict";
exports.big = (ch, n) => process.stdout.write(ch.repeat(n) + "\n");
exports.later = (fn) => setTimeout(fn, 1);
