// The JavaScript form of the built-in question: a computed global write of
// an unrelated name leaves Math, JSON and Reflect as their built-in values,
// so `typeof Math` answers "object" and their members still work.
const key = "appState";
globalThis[key] = 1;
console.log(globalThis[key], typeof Math, typeof JSON, typeof Reflect);
console.log(typeof Infinity, typeof NaN, typeof Infinity === "number");
console.log(Math.max(2, 7), JSON.stringify({ ok: true }), Reflect.ownKeys({ a: 1 }).length);
