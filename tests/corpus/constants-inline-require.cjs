// Reflection over an inline require of node:constants reads the CommonJS
// exports object the module returns: a feature probe and Object.keys work
// on it, and it keeps its inherited members.
console.log("O_RDONLY" in require("node:constants"));
console.log(require("node:constants").hasOwnProperty("X_OK"));
console.log(require("node:constants").hasOwnProperty("NOT_A_CONSTANT"));
console.log(Object.keys(require("node:constants")).indexOf("default"));
console.log("toString" in require("node:constants"));
console.log(typeof require("node:constants").O_RDONLY);
