/* An installed package's JSON document is data the loader reads: through
 * module.require it is the same document the bare require loads, one shared
 * parsed object, not a runtime refusal. */
console.log("method", module.require("pkg/data.json").v);
console.log("bare", require("pkg/data.json").v);
console.log("shared", module.require("pkg/data.json") === require("pkg/data.json"));
