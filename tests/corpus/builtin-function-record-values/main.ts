// A builtin function stored in a JavaScript record is a real function:
// TypeScript consumers call it through the record.
import native from "./native.js";
const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const id = native.randomUUID();
console.log(typeof id, id.length, shape.test(id));
const ids = new Set<string>();
for (let i = 0; i < 50; i++) ids.add(native.randomUUID());
console.log(ids.size);
console.log(shape.test(native.randomUUID({ disableEntropyCache: true })));
