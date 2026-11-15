"use strict";
exports.write = (s) => process.stdout.write(s);
exports.big = (ch, n) => process.stdout.write(ch.repeat(n) + "\n");
exports.bigCb = (ch, n, cb) => process.stdout.write(ch.repeat(n) + "\n", cb);
exports.exit = (c) => process.exit(c);
