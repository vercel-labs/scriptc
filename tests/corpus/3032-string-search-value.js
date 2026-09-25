console.log("undefined".indexOf(), "x".indexOf(), "undefined".includes(), "x".includes());
console.log("undefined".startsWith(), "x".startsWith(), "xundefined".endsWith(), "x".endsWith());
console.log("undefined".indexOf(undefined), "undefined".includes(void 0));
console.log("undefined".startsWith(undefined), "undefined".endsWith(undefined));
console.log("anullb".indexOf(null), "anullb".includes(null));
console.log("nulla".startsWith(null), "anull".endsWith(null));
console.log("truefalse".indexOf(true), "truefalse".includes(false));
console.log("truefalse".startsWith(true), "truefalse".endsWith(false));
console.log("42".indexOf(42), "42".includes(42), "42".startsWith(42), "42".endsWith(42));
console.log("1".indexOf(1n), "1".includes(1n), "1".startsWith(1n), "1".endsWith(1n));

/** @param {string | number | boolean | null | undefined} value */
function search(value) {
  const text = "undefined-null-1-true";
  console.log(text.indexOf(value), text.includes(value), text.startsWith(value), text.endsWith(value));
}
search(undefined);
search(null);
search(1);
search(true);
search("true");

let trace = "";
function receiver() { trace += "r"; return "undefined"; }
function needleEffect() { trace += "n"; return 1; }
console.log(receiver().indexOf(void needleEffect()), trace);
trace = "";
console.log(receiver().includes(void needleEffect()), trace);
trace = "";
console.log(receiver().startsWith(void needleEffect()), trace);
trace = "";
console.log(receiver().endsWith(void needleEffect()), trace);

function nullEffect() { trace += "n"; return null; }
trace = "";
console.log(receiver().indexOf(nullEffect()), trace);
