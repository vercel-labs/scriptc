// Keys appear in the order the module first wrote them, not sorted; a
// write inside a function lands when the function runs.
const lib = require("./lib");
console.log(Object.keys(lib).join(","));
for (const key in lib) console.log(key, typeof lib[key]);
lib.later();
console.log(Object.keys(lib).join(","), JSON.stringify(lib));
console.log(Object.entries(lib).map(([k, v]) => k + "=" + typeof v).join(" "));
lib.added = true;
console.log(Object.keys(lib).join(","));
