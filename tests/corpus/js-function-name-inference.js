// V8 names a function by its definition: an anonymous function or class
// expression takes the name of the binding or property it initializes, and
// every other value keeps the name it already has. A builtin function bound
// to a variable is therefore still `String`, not the variable's name.
var FromVar = String;
console.log(FromVar.name, FromVar.length, FromVar === String);
let FromLet = Number;
console.log(FromLet.name, FromLet === Number);
const FromConst = Boolean;
console.log(FromConst.name);
var Chained = FromVar;
console.log(Chained.name);
let ThroughParens = (Number);
console.log(ThroughParens.name);
console.log(String.name, Number.name, Boolean.name);

function declared() {}
var Held = declared;
console.log(Held.name);

// Anonymous definitions still take the binding's name.
var Anonymous = function () {};
console.log(Anonymous.name);
let Arrow = () => {};
console.log(Arrow.name);
const Parenthesized = (function () {});
console.log(Parenthesized.name);
const Class = class {};
console.log(Class.name);
var Named = function inner() {};
console.log(Named.name);
const NamedClass = class InnerClass {};
console.log(NamedClass.name);
