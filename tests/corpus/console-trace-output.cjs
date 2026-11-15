// console.trace prints Node's `Trace[: message]` heading on stderr, followed
// by the frames of the calls above the trace call, as one console write per
// call. The heading text, the write shape, the group indentation and the
// "    at name (file)" rendering of a frame line are what both sides spell
// the same way; the frames' own text is a property of the runtime (Node's
// stack also names its module loader, and a native build's stack is the
// program's own calls), so this program compares the heading lines and the
// shape of the frame lines.
const chunks = [];
const original = process.stderr.write;
process.stderr.write = function (chunk) {
  chunks.push(String(chunk));
  return true;
};

console.trace("top level");
console.trace();

function labelled(label) {
  console.trace(label);
}
labelled("inside a function");

function traced() {
  console.trace("from traced", 1, { a: 2 });
  console.trace("%s=%d", "x%d", 5);
  console.trace("two\nlines");
}
traced();

function grouped() {
  console.group("group");
  console.trace("grouped");
  console.groupEnd();
}
grouped();

process.stderr.write = original;

const lines = (chunk) => chunk.split("\n").filter((line) => line.length > 0);
const frames = (chunk) => lines(chunk).slice(1);
const [
  topLevel,
  bare,
  inside,
  fromTraced,
  formatted,
  multiline,
  inGroup,
] = chunks;

console.log("writes", chunks.length);
console.log("newline", chunks.every((chunk) => chunk.endsWith("\n")));
console.log(
  "headings",
  JSON.stringify(
    [topLevel, bare, inside, fromTraced, formatted, inGroup].map((chunk) => lines(chunk)[0]),
  ),
);
// A module-level call has no source frame in a native build, so only its
// heading line is comparable; the frames of a call inside a function are.
const frameShape = (chunk) => {
  const rows = frames(chunk);
  return [
    rows.length > 0,
    rows.every((line) => line.startsWith("    at ")),
    rows.some((line) => /\b(?:labelled|traced) \(/.test(line)),
  ];
};
console.log("labelled", ...frameShape(inside));
console.log("traced", ...frameShape(fromTraced));
console.log("formatted", ...frameShape(formatted));
console.log("multiline", JSON.stringify(lines(multiline).slice(0, 2)));
console.log("multiline frames", frames(multiline).length > 0, frames(multiline).slice(1).every((line) => line.startsWith("    at ")));
console.log(
  "group",
  JSON.stringify(lines(inGroup)[0]),
  frames(inGroup).length > 0,
  frames(inGroup).every((line) => line.startsWith("      at ")),
  frames(inGroup).some((line) => /\bgrouped \(/.test(line)),
);
