// `new readline.Interface(...)`: Node's createInterface calls this
// constructor with the same arguments, and a JavaScript file may call it
// directly. Its declaration is protected, which JavaScript does not
// enforce.
"use strict";
const readline = require("readline");
const readlinePromises = require("readline/promises");
const { Interface } = require("readline");
const { PassThrough } = require("stream");

// The options form.
const a = new PassThrough();
const rlA = new readline.Interface({ input: a, terminal: false });
console.log("instanceof", rlA instanceof readline.Interface);
const linesA = [];
rlA.on("line", (line) => {
  linesA.push(line);
});
rlA.on("close", () => {
  console.log("options", JSON.stringify(linesA));
});
a.write("one\ntwo\n");
a.end("three");

// The positional form, through a destructured binding.
const b = new PassThrough();
const outB = new PassThrough();
const rlB = new Interface(b, outB);
const linesB = [];
rlB.on("line", (line) => {
  linesB.push(line);
});
rlB.on("close", () => {
  console.log("positional", JSON.stringify(linesB));
});
b.write("four\r\nfive\n");
b.end();

// readline/promises' Interface.
const c = new PassThrough();
const rlC = new readlinePromises.Interface({ input: c, crlfDelay: Infinity });
console.log("promises instanceof", rlC instanceof readlinePromises.Interface);
const linesC = [];
rlC.on("line", (line) => {
  linesC.push(line);
});
rlC.on("close", () => {
  console.log("promises", JSON.stringify(linesC));
});
c.end("six\nseven");

