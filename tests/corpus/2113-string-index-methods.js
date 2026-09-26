const word = "café";
console.log(word.at(0), word.at(-1), word.at(-5), word.at(4));
console.log("abcdef".at(-1.9), "abcdef".at(1.9), "abcdef".at(-Infinity), "abcdef".at(NaN));
console.log("abc".at("1"), "abc".at(false), "abc".at(null), "abc".at(undefined));
console.log("abc".at([1]), "abc".at([]), "abc".at(function () {}));

const astral = "A😀B";
console.log(astral.codePointAt(0), astral.codePointAt(1), astral.codePointAt(2), astral.codePointAt(3), astral.codePointAt(4));
console.log(astral.codePointAt(-1), astral.codePointAt(Infinity), astral.codePointAt(NaN));
console.log(astral.codePointAt("1.9"), astral.codePointAt([3]), astral.codePointAt([]));
console.log(String.prototype.at.call(12345, -1), String.prototype.codePointAt.call(true, 0));

let order = "";
function receiver() { order += "r"; return "abc"; }
function argument() { order += "a"; return { valueOf() { order += "v"; return 1.8; } }; }
console.log(receiver().at(argument()), order);
order = "";
console.log(String.prototype.codePointAt.call(receiver(), argument()), order);

order = "";
function touched() { order += "x"; return 0; }
try { String.prototype.at.call(undefined, touched()); } catch (error) { console.log(error.name, error.message, order); }
try { String.prototype.codePointAt.call(null, touched()); } catch (error) { console.log(error.name, error.message, order); }
