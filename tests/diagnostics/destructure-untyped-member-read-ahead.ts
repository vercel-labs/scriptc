// A destructuring assignment into members of an untyped object reads its
// source one part at a time, after the earlier targets were assigned, as
// Node does: from an untyped array by index, or from a literal of the
// statement, which is complete before the first write
// (tests/corpus/8836-js-destructure-member-targets.mjs). A typed source may
// be a copy made where the value entered its type, so the writes would not
// reach it: it stays refused.
const box: any = { list: ["x", "y", "z"], first: "", last: "" };
const typed: string[] = box.list;
[box.list[2], box.list[0]] = typed;
const pair: [string, string] = ["a", "b"];
[box.first, box.last] = pair;
console.log(box);
