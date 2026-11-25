// Runs before install.ts, so the global object has no `document` or
// `counter` property yet. Each `typeof` guard answers "undefined" without
// reading the name: Node's answer for a declared global with no property,
// and the guard a feature test relies on.
export const before = [
  typeof document === "undefined",
  typeof document !== "undefined",
  typeof counter === "undefined",
];
if (typeof document === "undefined") console.log("guard: absent");
else console.log("guard: present");
