// console as a value: one object, whichever way the program reaches it.
const held = console;
console.log(held === console, typeof console, typeof held);
held.log("through a binding", 1);
held.error("stderr through a binding");

function useUntyped(target: any): void {
  target.log("untyped", 2);
  target.warn("untyped %s", "format");
  console.log(typeof target.log, typeof target.table, typeof target.missing);
}
useUntyped(console);

function isConsole(value: unknown): boolean {
  return value === console;
}
console.log(isConsole(console), isConsole(held), isConsole({}));

const holder = { target: console, label: "holder" };
holder.target.log(holder.label);
const targets = [console, console];
console.log(targets[0] === targets[1], targets.length);

// A copy has console's own keys, in console's order; a replaced member
// is the copy's alone.
const quiet = { ...console, log: (..._args: unknown[]): void => {} };
quiet.log("hidden");
quiet.error("shown on stderr");
quiet.info("shown %s", "formatted");
console.log(typeof quiet.warn, typeof quiet.table, quiet.error === console.error);
console.log(Object.keys({ ...console }).join(","));

const level: "log" | "error" = process.argv.length > 99 ? "error" : "log";
console[level]("computed member");
console.log(typeof console.table, typeof console.profile === "function", !console.time);


// Membership follows the keys Node's console has.
const names = ["log", "table", "missing", "_stdout", "toString", "hasOwnProperty", "__proto__", "k:log"];
console.log("log" in console, "nope" in console, "toString" in console, "__proto__" in console);
console.log(names.map((name) => name in console).join(","));
