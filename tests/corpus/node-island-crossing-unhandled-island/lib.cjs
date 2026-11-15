"use strict";
exports.failing = (ms, m) => new Promise((_, r) => setTimeout(() => r(new Error(m)), ms));
