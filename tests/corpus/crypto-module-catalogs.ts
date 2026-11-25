// The full name lists behind getHashes, getCiphers and getCurves, which the
// build's OpenSSL provider defines, in their order and spelling; every call
// answers a new plain array, so appending to one does not leak into the
// next.
import { getCiphers, getCurves, getHashes } from "node:crypto";

const hashes = getHashes();
const ciphers = getCiphers();
const curves = getCurves();
console.log("hashes", JSON.stringify(hashes));
console.log("ciphers", JSON.stringify(ciphers));
console.log("curves", JSON.stringify(curves));

const repeats = [getHashes(), getCiphers(), getCurves()];
console.log(
  "fresh",
  repeats[0] !== hashes,
  repeats[1] !== ciphers,
  repeats[2] !== curves,
  JSON.stringify(repeats.map((list) => list.length)),
);
hashes.push("mutated");
ciphers.length = 0;
curves[0] = "mutated";
console.log(
  "isolation",
  getHashes().includes("mutated"),
  hashes.includes("mutated"),
  getCiphers().length > 0,
  ciphers.length,
  getCurves()[0] !== "mutated",
  curves[0],
);
console.log(
  "prototypes",
  Object.getPrototypeOf(getHashes()) === Array.prototype,
  Object.getPrototypeOf(getCiphers()) === Array.prototype,
  Object.getPrototypeOf(getCurves()) === Array.prototype,
  Array.isArray(getHashes()) && Array.isArray(getCiphers()) && Array.isArray(getCurves()),
);

// The lists hold only strings, with no empty names and no repeats.
for (const [label, list] of [
  ["hashes", getHashes()],
  ["ciphers", getCiphers()],
  ["curves", getCurves()],
] as [string, string[]][]) {
  console.log(
    label,
    list.every((name) => typeof name === "string" && name.length > 0),
    new Set(list).size === list.length,
    list.every((name) => name === name.trim()),
  );
}
