// The `Math`, `JSON` and `Reflect` objects are real objects: a program that
// only reaches their members through the object (element access, reflection)
// may replace and delete them, and the object answers the replacement.
const math = Math;
console.log(typeof math["abs"], math["abs"].name, math["abs"].length);
console.log(math["abs"](-3), math["min"].length, math["max"].length, math["hypot"].length);

const original = math["abs"];
math["abs"] = function (value) {
  return value * 7;
};
console.log(math["abs"](3), Object.getOwnPropertyDescriptor(math, "abs").writable);
delete math["abs"];
console.log("abs" in math);

math["abs"] = original;
console.log(math["abs"](-2));
const pi = Object.getOwnPropertyDescriptor(math, "PI");
console.log(math["PI"], pi.writable, pi.configurable, pi.enumerable);

const reflect = Reflect;
console.log(typeof reflect["get"], reflect["get"].length);
reflect["get"] = "replaced";
console.log(reflect["get"]);
delete reflect["get"];
console.log("get" in reflect);

const json = JSON;
console.log(typeof json["parse"], json["parse"].length, json["stringify"].length);
json["parse"] = function (text) {
  return text.length;
};
console.log(json["parse"]('{"a":1}'));
