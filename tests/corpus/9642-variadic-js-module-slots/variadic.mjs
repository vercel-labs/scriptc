// Untyped functions that observe every argument they are called with.
function show(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean")
    return typeof value + ":" + String(value);
  if (typeof value === "function") return "function";
  if (Array.isArray(value)) return "array:" + value.length;
  return "object";
}
export function rest(...args) {
  let seen = "";
  for (let i = 0; i < args.length; i++) seen += (i > 0 ? "|" : "") + show(args[i]);
  console.log("rest", this === undefined ? "undefined" : typeof this, args.length, seen);
}
export function counted() {
  let seen = "";
  for (let i = 0; i < arguments.length; i++) seen += (i > 0 ? "|" : "") + show(arguments[i]);
  console.log("arguments", this === undefined ? "undefined" : typeof this, arguments.length, seen);
}
export function lead(first, ...more) {
  console.log("lead", show(first), more.length);
}
export function quiet(...args) {
  let seen = "";
  for (let i = 0; i < args.length; i++) seen += (i > 0 ? "|" : "") + show(args[i]);
  console.log("quiet", args.length, seen);
}
export function tally() {
  console.log("tally", arguments.length);
}
