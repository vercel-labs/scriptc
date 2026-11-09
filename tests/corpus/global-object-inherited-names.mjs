// What a program learns about the global object beyond its own globals: the
// names it inherits from Object.prototype are present and read as that
// prototype's members, `navigator` is there under a feature test,
// Object.keys lists Node's enumerable globals and then what the program
// wrote, and the object carries its Symbol.toStringTag.

console.log(typeof globalThis.toString, typeof globalThis.hasOwnProperty, typeof globalThis.constructor);
console.log(globalThis.toString === Object.prototype.toString, globalThis.hasOwnProperty === Object.prototype.hasOwnProperty);
console.log(globalThis.toString === undefined, globalThis.constructor ? "has" : "lacks", globalThis.valueOf ? "has" : "lacks");

// The same names as free names.
console.log(typeof toString, typeof hasOwnProperty, typeof constructor);
if (typeof toString !== "undefined") console.log("inherited name present");
else console.log("inherited name absent");

// The inherited functions are the ones Object.prototype holds.
const text = globalThis.toString;
console.log(text.call([]), text.call(null), typeof text);
const owns = globalThis.hasOwnProperty;
console.log(owns.call({ bolt: 1 }, "bolt"), owns.call({ bolt: 1 }, "nut"));

// Through a binding that holds the global object, and a key chosen at run time.
const host = globalThis;
const picked = ["toString", "hasOwnProperty"][1];
console.log("toString" in host, typeof host.toString, picked in host, typeof host.constructor);

// navigator under a feature test.
if (typeof navigator !== "undefined") console.log("navigator present");
else console.log("navigator absent");
console.log(typeof navigator !== "undefined" && navigator.language ? "language" : "none");

// Object.keys: Node's fifteen enumerable globals in Node's order (whatever
// started the program may have defined more after them), then the program's own.
console.log(Object.keys(globalThis).slice(0, 15).join(","));
globalThis.depot = 1;
globalThis.crate = 2;
console.log(Object.keys(globalThis).slice(-2).join(","), Object.keys(host).includes("depot"), Object.keys(host).includes("Array"));

// The symbol tag.
console.log(Symbol.toStringTag in globalThis, Symbol.iterator in globalThis, globalThis[Symbol.toStringTag]);
