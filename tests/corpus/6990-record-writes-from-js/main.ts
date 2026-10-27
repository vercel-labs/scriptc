// A typed object literal passed to untyped JavaScript keeps the properties
// that code adds: JSON.stringify, Object.keys, later untyped reads and
// console.log see them, in JavaScript's own-key order (integer keys first).
import { keysOf, remove, write } from "./helpers.js";

const numbered = { 0: "zero", 1.5: "x" };
write(numbered, 2, "two");
console.log(JSON.stringify(numbered), keysOf(numbered), Object.keys(numbered));

const point = { x: 1, y: 2 };
write(point, "label", "origin");
write(point, "x", 10);
console.log(JSON.stringify(point), point.x, keysOf(point));
write(point, "label", "moved");
console.log(JSON.stringify(point));
remove(point, "label");
console.log(JSON.stringify(point), keysOf(point));

const config = { name: "app", retries: 3 };
write(config, "debug", true);
write(config, "tags", ["a", "b"]);
console.log(JSON.stringify(config), keysOf(config));
console.log(config);

// Many integer keys added in descending order serialize in ascending order.
const many = { name: "many" };
for (let i = 3000; i > 0; i--) write(many, i, i);
const text = JSON.stringify(many);
console.log(text.length, text.slice(0, 40), text.slice(-30));
