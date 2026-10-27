// Unary + in JavaScript on values that may be undefined or null: command-line
// argument slots, Map lookups, optional parameters and nullable values convert
// as Number(value) does (undefined to NaN, null to 0).
function show(label, value) {
  console.log(label, Object.is(value, -0) ? "-0" : String(value));
}

// No arguments: the first argument slot is undefined.
const n = +process.argv[2];
show("argv[2]", n);
show("argv[2] doubled", +process.argv[2] * 2);
show("argv[2] or default", +process.argv[2] || 100);
show("argv[0] is a path", +process.argv[0]);

const settings = new Map([
  ["width", "640"],
  ["ratio", "1.5"],
  ["blank", " "],
]);
show("map width", +settings.get("width"));
show("map ratio", +settings.get("ratio"));
show("map blank", +settings.get("blank"));
show("map missing", +settings.get("height"));
show("map sum", +settings.get("width") + +settings.get("ratio"));
show("negated", -+settings.get("width"));

function plusOptional(value) {
  return +value;
}
for (const text of ["42", " 0x1F ", "", "1e3", "-0", "abc", undefined]) {
  show(`optional ${String(text)}`, plusOptional(text));
}

function plusParameter(value = undefined) {
  return +value;
}
show("parameter missing", plusParameter());
show("parameter given", plusParameter("12.5"));

const words = ["3", "x"];
show("past the end", +words[5]);
show("in range", +words[0]);

const lookup = { a: "8" };
show("missing key", +lookup.b);
show("present key", +lookup.a);

const maybeNull = words.length > 1 ? null : "1";
show("null", +maybeNull);
