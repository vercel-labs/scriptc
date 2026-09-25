console.log("undefined".lastIndexOf(), "".lastIndexOf(), "undefinedundefined".lastIndexOf());
console.log("gnullunazzgnull".lastIndexOf(null));
console.log("undefined".lastIndexOf(undefined), "undefined".lastIndexOf(void 0));
console.log("truefalse".lastIndexOf(true), "42".lastIndexOf(42), "1".lastIndexOf(1n));

const missing = undefined;
const nil = null;
console.log("undefined".lastIndexOf(missing), "nullnull".lastIndexOf(nil));

let trace = "";
function receiver() { trace += "r"; return "xundefined"; }
function needleEffect() { trace += "n"; return 1; }
console.log(receiver().lastIndexOf(void needleEffect()), trace);
