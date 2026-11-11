// An object pattern over a process stream binds the members a stream value
// answers as data. A rest element, a method, a member the stream value does
// not answer, a key known only at run time, and a destructuring assignment
// stay refused, each by name.
const { isTTY, ...others } = process.stdout;
const { write } = process.stderr;
const { writable } = process.stdout;
const key: "rows" | "columns" = process.argv.length > 5 ? "rows" : "columns";
const { [key]: extent } = process.stdout;
let fd: number;
({ fd } = process.stderr);
console.log(isTTY, others, write, writable, extent, fd);
