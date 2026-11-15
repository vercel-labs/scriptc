// `key in globalThis` answers what Node's global object has: its value
// properties, the builtin globals, the names it inherits from
// Object.prototype, and the properties the program adds, with a literal key
// and with a computed one. Reflect.has asks the same question.
type Holder = { mine?: number; held?: undefined };

console.log("undefined" in globalThis, "NaN" in globalThis, "Infinity" in globalThis);
console.log("globalThis" in globalThis, "Array" in globalThis, "parseInt" in globalThis);
console.log("console" in globalThis, "process" in globalThis, "setTimeout" in globalThis);
console.log("toString" in globalThis, "hasOwnProperty" in globalThis, "constructor" in globalThis);
console.log("absent" in globalThis, "window" in globalThis, "localStorage" in globalThis);
console.log("require" in globalThis, "module" in globalThis, "exports" in globalThis);

const names: string[] = [
  "undefined",
  "NaN",
  "Infinity",
  "globalThis",
  "global",
  "Array",
  "Map",
  "JSON",
  "parseInt",
  "isNaN",
  "console",
  "process",
  "Buffer",
  "URL",
  "fetch",
  "navigator",
  "queueMicrotask",
  "structuredClone",
  "toString",
  "valueOf",
  "__proto__",
  "absent",
  "window",
  "self",
  "document",
  "sessionStorage",
  "__filename",
  "__dirname",
];
for (const name of names) console.log(name, name in globalThis);

// A property the program adds is present from the write on.
console.log("mine" in globalThis, names.includes("mine"));
(globalThis as Holder).mine = 1;
console.log("mine" in globalThis, "other" in globalThis);
const own: string = ["mi", "ne"].join("");
console.log(own in globalThis);
(globalThis as Holder).held = undefined;
console.log("held" in globalThis);

// The same object through `global`, an alias and Reflect.has.
const alias = globalThis;
console.log("NaN" in global, "mine" in global, "absent" in global);
console.log("NaN" in alias, "mine" in alias, "absent" in alias);
console.log(Reflect.has(globalThis, "NaN"), Reflect.has(globalThis, "mine"));
console.log(Reflect.has(globalThis, "absent"), Reflect.has(globalThis, own));
