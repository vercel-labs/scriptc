console.log(String.prototype.trim.call(" \u00a0 x \n"), String.prototype.trim.call(false), String.prototype.trim.call(-0));
console.log(String.prototype.trimStart.call(12), String.prototype.trimEnd.call(true));
console.log(String.prototype.trimLeft.call("  x"), String.prototype.trimRight.call("x  "));
console.log(String.prototype.charAt.call(12345, 2), String.prototype.charCodeAt.call("AB", 1));
console.log(String.prototype.indexOf.call(12345, "3"), String.prototype.includes.call(12345, 34));
console.log(String.prototype.startsWith.call("abc", "b", 1), String.prototype.endsWith.call("abc", "b", 2));
console.log(String.prototype.slice.call(true, 1), String.prototype.substring.call("abcdef", "2", "4"));
console.log(String.prototype.repeat.call(12, "2"), String.prototype.padStart.call(42, 4, "0"), String.prototype.padEnd.call(42, 4, "0"));
console.log(String.prototype.split.call("a,b", ",").join("|"), String.prototype.toLowerCase.call("ABC"), String.prototype.toUpperCase.call("abc"));
console.log(String.prototype.trim.call({}), String.prototype.trim.call([1, 2]), String.prototype.trim.call(new Error("test")));

const scalar = Math.floor(1.9) === 1 ? 42 : "  abc  ";
console.log(String.prototype.trim.call(scalar));

let trace = "";
function receiver() { trace += "r"; return "  ab  "; }
function search() { trace += "s"; return "a"; }
function position() { trace += "p"; return "2"; }
console.log(String.prototype.indexOf.call(receiver(), search(), position()), trace);

let nullishTrace = "";
function nullReceiver() { nullishTrace += "r"; return null; }
function searched() { nullishTrace += "s"; return "x"; }
try {
  String.prototype.indexOf.call(nullReceiver(), searched());
} catch (error) {
  console.log(nullishTrace, error.name);
}
try {
  String.prototype.trim.call(undefined);
} catch (error) {
  console.log(error.name);
}
try {
  String.prototype.split.call();
} catch (error) {
  console.log(error.name);
}

let extraTrace = "";
function extra() { extraTrace += "e"; throw new Error("argument"); }
try {
  String.prototype.trim.call(null, extra());
} catch (error) {
  console.log(extraTrace, error.message);
}
