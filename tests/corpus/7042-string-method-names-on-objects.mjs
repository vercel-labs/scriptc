// Objects whose members share names with String.prototype methods, filled
// in after their declaration. A call dispatches on the receiver's runtime
// kind: a string runs the String method, any other value its own member.
var helpers = {};
var initialized;
function setup() {
  if (initialized) return helpers;
  initialized = true;
  function repeat(text, count) {
    let out = "";
    for (let i = 0; i < count; i += 1) out += text;
    return out;
  }
  function padStart(text, width, fill) {
    let out = String(text);
    while (out.length < width) out = fill + out;
    return out;
  }
  helpers.repeat = repeat;
  helpers.padStart = padStart;
  helpers.trim = function (value) {
    return "<" + value + ">";
  };
  helpers.split = (value, separator) => [value, separator, "own"];
  helpers.toUpperCase = () => "own upper";
  return helpers;
}

const h = setup();
console.log("[" + h.repeat("ab", 3) + "]", "[" + h.repeat("-", 0) + "]");
console.log(h.padStart(7, 3, "0"), h.padStart("long", 2, "*"));
console.log(h.trim("  x  "), h.split("a,b", ","), h.toUpperCase());

const indent = h.repeat(" ", 2);
console.log("[" + indent + "]", indent.length);
const lines = ["one", "two"].map((line, index) => h.padStart(index + 1, 3, " ") + " | " + line);
console.log(lines.join("\n"));

// The same names on a missing member throw Node's TypeError.
var partial = {};
function fillPartial() {
  partial.present = true;
}
fillPartial();
try {
  partial.repeat("x", 2);
} catch (error) {
  console.log(error instanceof TypeError, error.message);
}
try {
  partial.trim();
} catch (error) {
  console.log(error instanceof TypeError, error.message);
}

// Arguments are evaluated once, in order, after the member is read.
const order = [];
var traced = {};
function fillTraced() {
  traced.replace = (a, b) => {
    order.push("call");
    return a + b;
  };
}
fillTraced();
function arg(value) {
  order.push("arg " + value);
  return value;
}
console.log(traced.replace(arg(1), arg(2)), order.join(", "));
