console.log("xundefinedy".indexOf(undefined, 1), "xundefinedy".includes(undefined, 1));
console.log("xundefinedy".startsWith(undefined, 1), "xundefinedy".endsWith(undefined, 10));
console.log("xnullnull".indexOf(null, 2), "xnullnull".includes(null, 5));
console.log("xnull".startsWith(null, 1), "xnull".endsWith(null, 5));
console.log("xtruefalse".indexOf(true, 1), "xtruefalse".includes(false, 5));
console.log("xtruefalse".startsWith(true, 1), "xtruefalse".endsWith(false, 10));
console.log("x42".indexOf(42, 1), "x42".includes(42, 1), "x42".startsWith(42, 1), "x42".endsWith(42, 3));
console.log("x1".indexOf(1n, 1), "x1".includes(1n, 1), "x1".startsWith(1n, 1), "x1".endsWith(1n, 2));
console.log("x0NaNInfinity".indexOf(-0, 1), "x0NaNInfinity".includes(NaN, 2));
console.log("xInfinity".startsWith(Infinity, 1), "xInfinity".endsWith(Infinity, 9));

/** @param {string | number | boolean | null | undefined} needle */
function search(needle) {
  const text = "xundefined-null-1-true";
  console.log(text.indexOf(needle, 1), text.includes(needle, 1), text.startsWith(needle, 1), text.endsWith(needle, 11));
}
search(undefined);
search(null);
search(1);
search(true);
search("undefined");

let trace = "";
function receiver() { trace += "r"; return "xundefinedy"; }
function needleEffect() { trace += "n"; return 1; }
function position() { trace += "p"; return "1"; }
console.log(receiver().indexOf(void needleEffect(), position()), trace);
trace = "";
console.log(receiver().includes(void needleEffect(), position()), trace);
trace = "";
console.log(receiver().startsWith(void needleEffect(), position()), trace);
trace = "";
console.log(receiver().endsWith(void needleEffect(), position()), trace);

function nullEffect() { trace += "n"; return null; }
trace = "";
console.log(receiver().indexOf(nullEffect(), position()), trace);
