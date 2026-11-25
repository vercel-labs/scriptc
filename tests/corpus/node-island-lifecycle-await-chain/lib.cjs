"use strict";
const log = (s) => console.log(s);
// Awaits the native step, which awaits this again: the chain crosses the
// boundary twice per level.
exports.down = async function down(n, native) {
  log(`island down ${n}`);
  if (n === 0) return "bottom";
  const r = await native(n - 1);
  log(`island up ${n}`);
  return `i${n}(${r})`;
};
exports.failAt = async function failAt(n, at, native) {
  try {
    if (n === at) throw new RangeError(`island failed at ${n}`);
    if (n === 0) return "bottom";
    return await native(n - 1);
  } finally {
    log(`island finally ${n}`);
  }
};
