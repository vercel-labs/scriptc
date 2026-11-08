// @requires-libnode
// for-in over the exports of a package that runs in a Node island visits
// the package's enumerable exports in the order the package made them, as
// it does over any object of the island. An export the package removes
// before the loop reaches it is skipped, and one it adds is not visited.
const crate = require("crate");

for (const key in require("crate")) console.log("export", key, typeof crate[key]);

const seen = [];
for (const key in crate) {
  seen.push(key);
  crate.unpack("label");
  crate.extra = 1;
}
console.log("during:", seen.join(","));

const after = [];
for (const key in crate) after.push(key);
console.log("after:", after.join(","));
console.log("serial:", crate.serial, "serial" in crate, after.includes("serial"));
