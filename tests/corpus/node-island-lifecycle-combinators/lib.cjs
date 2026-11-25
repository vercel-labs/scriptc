"use strict";
exports.ok = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
exports.fail = (ms, m) => new Promise((_, r) => setTimeout(() => r(new Error(m)), ms));
