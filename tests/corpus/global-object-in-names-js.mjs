// `key in globalThis` in a JavaScript source: Node's global object answers
// for its value properties, the builtin globals, the names it inherits and
// the properties the program adds.
console.log("undefined" in globalThis, "NaN" in globalThis, "Infinity" in globalThis);
console.log("globalThis" in globalThis, "Array" in globalThis, "parseInt" in globalThis);
console.log("toString" in globalThis, "hasOwnProperty" in globalThis, "__proto__" in globalThis);
console.log("absent" in globalThis, "window" in globalThis, "localStorage" in globalThis);
console.log("require" in globalThis, "module" in globalThis, "__filename" in globalThis);

const names = ["undefined", "NaN", "Infinity", "globalThis", "global", "Array", "Symbol", "parseInt"];
names.push("console", "process", "Buffer", "navigator", "valueOf", "absent", "self", "document");
for (const name of names) console.log(name, name in globalThis);

function has(key) {
  return key in globalThis;
}
console.log(has("Promise"), has("mine"), has(Symbol.for("global-object-in-names")));
globalThis.mine = 1;
console.log("mine" in globalThis, has("mine"), has("other"));
globalThis.held = undefined;
console.log("held" in globalThis, has("held"));

const alias = globalThis;
console.log("NaN" in global, "mine" in alias, "absent" in alias);
console.log(Reflect.has(globalThis, "Infinity"), Reflect.has(globalThis, "mine"));
console.log(Reflect.has(globalThis, "absent"), Reflect.has(alias, "undefined"));
