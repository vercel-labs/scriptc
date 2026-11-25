// The TypeScript opinions the SC0001 triage admits, each a legal JavaScript
// construct the lowering already builds Node-exactly (tsc-codes.ts,
// JS_TSC_CODE_TRIAGE: 1313, 2378, 2447, 2678, 2698, 2774, 2783, 2872,
// 2873). Node is the oracle for every line below.
// A getter with no return answers undefined (TS2378).
const o = {
  get x() {},
};
console.log(o.x);
// Object spread of null contributes nothing (TS2698), and a later spread
// overwriting an earlier property wins (TS2783).
const s = { a: 1 };
console.log(JSON.stringify({ ...null, ...s }));
console.log(JSON.stringify({ a: 2, ...s }));
// Bitwise operators on booleans convert with ToInt32 (TS2447).
console.log(true & false, true | true, true ^ true);
// A switch whose cases the checker proves disjoint still compares (TS2678).
const v = 1;
switch (v) {
  case 0:
    console.log("zero");
    break;
  case 1:
    console.log("one");
    break;
}
// A function reference is truthy (TS2774); an object literal is always
// truthy and an empty string always falsy (TS2872, TS2873).
const fn = () => 1;
console.log(fn ? "fn" : "no");
if ({}) console.log("truthy");
if ("") console.log("emptystr");
// An empty statement as an 'if' body is legal JavaScript (TS1313).
if (v) ;
console.log("after");
