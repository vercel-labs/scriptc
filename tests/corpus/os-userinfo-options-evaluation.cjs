// os.userInfo reads its options the way Node reads them: the argument
// expression runs even when it names no encoding, a computed key that
// spells "encoding" is the encoding member, a constant whose type pins
// the spelling names the same encoding, and another member's value is
// evaluated where it sits and then dropped.
const os = require("node:os");

const plain = os.userInfo();

function make() {
  console.log("make ran");
  return {};
}
const made = os.userInfo(make());
console.log("argument evaluated", made.username === plain.username, typeof made.shell);

const order = [];
function member(label, value) {
  order.push(label);
  return value;
}
const ignored = os.userInfo({
  bogus: member("bogus", 1),
  other: member("other", "x"),
  encoding: "utf8",
});
console.log("members evaluated", order.join(","), ignored.username === plain.username);

const computed = os.userInfo({ ["encoding"]: "buffer" });
console.log("computed key", Buffer.isBuffer(computed.username), Buffer.isBuffer(computed.homedir));

const templated = os.userInfo({ [`encoding`]: "buffer" });
console.log("template key", Buffer.isBuffer(templated.username));

const KEY = "encoding";
const fromKey = os.userInfo({ [KEY]: "buffer" });
console.log("constant key", Buffer.isBuffer(fromKey.username));

const ENCODING = "buffer";
const fromConstant = os.userInfo({ encoding: ENCODING });
console.log("constant encoding", Buffer.isBuffer(fromConstant.username));

const fromShorthand = os.userInfo({ encoding: ENCODING });
console.log("last definition", Buffer.isBuffer(fromShorthand.username));

// Accessors: a setter-only member reads as undefined, the utf8 default, and
// a method's value is a function, which ParseEncoding also reads as utf8.
// (A getter, or a setter completing a getter's pair, computes the value the
// binding reads, so that shape is rejected at compile time.)
const setterOnly = os.userInfo({ set encoding(_value) {} });
console.log("setter only", typeof setterOnly.username, setterOnly.username === plain.username);
const methodMember = os.userInfo({
  encoding() {
    return "buffer";
  },
});
console.log("method member", typeof methodMember.username);
