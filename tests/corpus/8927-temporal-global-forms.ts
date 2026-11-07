// More ways a program refers to the Temporal global, each of which needs
// TypeScript's Temporal declarations to type-check and answers as Node 24
// does, where the global is not defined. A type-only declaration of the name
// binds types, not the value a `typeof` test reads; and destructuring the
// global object reads its member.
type Temporal = { label: string };
const local: Temporal = { label: "a local type" };
console.log(local.label, typeof Temporal);

const { Temporal: fromGlobal } = globalThis;
console.log(fromGlobal === undefined);

// The same member through an alias of the global object.
const root = globalThis;
console.log(root.Temporal === undefined);

export {};
