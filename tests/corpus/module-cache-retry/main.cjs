/* A failed require leaves no entry: retrying a throwing lazy dependency must
 * keep require.cache's live view the same size, so the work it costs stays
 * flat instead of growing with every attempt. */
const cache = require.cache;
const keysBefore = Object.keys(cache).length;
let failures = 0;
for (let attempt = 0; attempt < 20000; attempt += 1) {
  try {
    require("./throws.cjs");
  } catch {
    failures += 1;
  }
}
console.log("failures", failures === 20000);
console.log("keys", Object.keys(cache).length === keysBefore);
console.log("entry", cache[require.resolve("./throws.cjs")] === undefined);
