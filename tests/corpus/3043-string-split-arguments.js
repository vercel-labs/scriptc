function show(value) { return JSON.stringify(value); }

console.log(show("a,b".split()), show("a,b".split(undefined)), show("".split()));
console.log(show("a,b".split(undefined, 0)), show("a,b".split(undefined, false)), show("a,b".split(undefined, null)));
console.log(show("a,b".split(undefined, 4294967296)), show("a,b".split(undefined, -1)));
console.log(show("trueXtrue".split(true)), show("xnullx".split(null)), show("12x12".split(12)));
console.log(show("1x1".split(1n)), show("falsexfalse".split(false)));
console.log(show("a,b,c".split(",", "2")), show("a,b,c".split(",", true)));
console.log(show("a,b,c".split(",", "4294967296")), show("a,b,c".split(",", "2.9")));
console.log(show("a,b,c".split(",", null)), show("a,b,c".split(",", undefined)));
let limitCalls = 0;
console.log(show("a,b".split(undefined, { valueOf() { limitCalls++; return 0; } })), limitCalls);
console.log(show("a,b".split(undefined, { valueOf() { limitCalls++; return 1; } })), limitCalls);

function mixedSeparator(which) { return which === 0 ? undefined : which === 1 ? "-" : null; }
function mixedLimit(which) { return which === 0 ? undefined : which === 1 ? "2" : false; }
console.log(show("x-null-y".split(mixedSeparator(0), mixedLimit(0))));
console.log(show("x-y-z".split(mixedSeparator(1), mixedLimit(1))));
console.log(show("xnullx".split(mixedSeparator(2), mixedLimit(2))));

let effects = "";
function sepEffect() { effects += "s"; return 1; }
function limitEffect() { effects += "l"; return 1; }
console.log(show("a,b".split(void sepEffect(), void limitEffect())), effects);

effects = "";
function separatorEffect() { effects += "s"; return ","; }
function objectLimit() { effects += "l"; return { valueOf() { effects += "L"; return 1; } }; }
console.log(show("a,b,c".split(separatorEffect(), objectLimit())), effects);

function noSeparator() { return undefined; }
function nullSeparator() { return null; }
function numberSeparator() { return 12; }
function stringLimit() { return "2"; }
console.log(show("x-y".split(noSeparator())), show("xnullx".split(nullSeparator())));
console.log(show("ab12cd".split(numberSeparator())), show("a-b-c".split("-", stringLimit())));

let order = "";
function receiver() { order += "r"; return 12; }
function sep() { order += "s"; return 2; }
function limit() { order += "l"; return "2"; }
console.log(show(String.prototype.split.call(receiver(), sep(), limit())), order);

order = "";
function undefinedSep() { order += "s"; return undefined; }
function zeroLimit() { order += "l"; return 4294967296; }
console.log(show(String.prototype.split.call("a,b", undefinedSep(), zeroLimit())), order);

order = "";
function laterSep() { order += "s"; return ","; }
function laterLimit() { order += "l"; return 2; }
try { String.prototype.split.call(null, laterSep(), laterLimit()); }
catch (error) { console.log(error.name, error.message, order); }

console.log(show(String.prototype.split.call(false, false)), show(String.prototype.split.call(12345, 2, 2)));
console.log(show(String.prototype.split.call("a,b")), show(String.prototype.split.call("a,b", undefined, 0)));
