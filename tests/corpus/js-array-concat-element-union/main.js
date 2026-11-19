const schema = require("./schema/json/schema.js");
console.log(schema.schema.length);
console.log(schema.schema.map((tag) => tag.tag).join(","));
console.log(schema.schema[5].tag === "", schema.schema[0].default);
