"use strict";
// switch over dynamic values with literal cases: strict equality against
// each boxed literal, so only a primitive of the same kind and value
// matches; a default in the middle still runs only after every case misses,
// and fallthrough continues in source order.
function tag(type) {
  switch (type) {
    case "div":
    case "span":
      return "inline-or-block:" + type;
    case "select":
      return "select";
    default:
      return "other:" + String(type);
    case "option":
      return "option";
    case "":
      return "empty";
  }
}
function num(value) {
  let out = "";
  switch (value) {
    case 0:
      out += "zero ";
    case 1:
      out += "one ";
      break;
    case NaN:
      out += "nan ";
      break;
    case true:
      out += "true ";
      break;
    default:
      out += "default ";
  }
  return out.trim();
}
const values = ["div", "span", "select", "option", "", "divx", { valueOf: () => "div" }, 7, null, undefined, { toString: () => "div" }];
for (const v of values) console.log(tag(v));
for (const v of [0, -0, 1, NaN, true, false, "0", 1n, [0]]) console.log(num(v));
const loose = [NaN, -0, "div", 1];
console.log(loose.map((x) => [x === "div", x === 1, x === 0, x !== x].join("/")).join(" "));
