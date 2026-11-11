// buffer.resolveObjectURL(id): Node coerces the id with ToString, then looks
// it up in the blob registry URL.createObjectURL fills. A compiled program
// cannot create a blob URL, so every id misses and the answer is undefined;
// the coercion still runs, and the errors it throws escape.
const { resolveObjectURL: fromNode } = require("node:buffer");
const bufferModule = require("buffer");

function show(label, fn) {
  try {
    console.log(label, "|", String(fn()));
  } catch (e) {
    console.log(label, "|", e.name, e.code, e.message);
  }
}

const id = "blob:nodedata:never-registered";
show("string", () => fromNode(id));
show("empty", () => fromNode(""));
show("omitted", () => fromNode());
show("undefined", () => fromNode(undefined));
show("null", () => fromNode(null));
show("number", () => fromNode(1));
show("bigint", () => fromNode(10n));
show("boolean", () => fromNode(false));
show("object", () => fromNode({}));
show("array", () => fromNode(["blob:made"]));
show("url", () => fromNode(new URL("blob:nodedata:x")));
show("blob", () => fromNode(new Blob(["x"])));
show("symbol", () => fromNode(Symbol("id")));

// The argument converts exactly once, through its own toString.
let conversions = 0;
const counted = {
  toString() {
    conversions++;
    return "blob:nodedata:" + conversions;
  },
};
show("counted", () => fromNode(counted));
show("counted again", () => fromNode(counted));
console.log("conversions", conversions);
const thrower = {
  toString() {
    throw new RangeError("boom");
  },
};
show("throwing toString", () => fromNode(thrower));

// The member through the stored module object answers the same miss.
show("member", () => bufferModule.resolveObjectURL(id));
