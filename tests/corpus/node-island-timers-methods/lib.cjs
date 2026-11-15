"use strict";
const log = (s) => console.log(s);
exports.timeout = (ms, label) => setTimeout(() => log(`island timeout ${label}`), ms);
exports.interval = (ms, label) => setInterval(() => log(`island interval ${label}`), ms);
exports.immediate = (label) => setImmediate(() => log(`island immediate ${label}`));
exports.hasRef = (t) => t.hasRef();
exports.clearById = (id) => clearTimeout(id);
