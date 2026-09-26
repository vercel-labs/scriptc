console.log(String.prototype.trim.call(new String("  text  ")));
console.log(String.prototype.trim.call(new String(undefined)));
console.log(String.prototype.trim.call(new String(null)));
console.log(String.prototype.trim.call(new Boolean(false)));
console.log(String.prototype.trim.call(new Boolean("")));
console.log(String.prototype.trim.call(new Number(" 12 ")));
console.log(String.prototype.trim.call(new Number()));
console.log(String.prototype.trim.call(new Number(undefined)));

let order = "";
var fallback = {
  toString: function() { order += "t"; return {}; },
  valueOf: function() { order += "v"; return "  fallback  "; },
};
console.log(String.prototype.trim.call(fallback), order);

order = "";
var preferred = {
  toString: function() { order += "t"; return "  preferred  "; },
  valueOf: function() { order += "v"; return "other"; },
};
console.log(String.prototype.trim.call(preferred), order);

var valueOnly = { valueOf: function() { return "ignored"; } };
console.log(String.prototype.trim.call(valueOnly));

var throwing = { toString: function() { throw new Error("hook failed"); } };
try {
  String.prototype.trim.call(throwing);
} catch (error) {
  console.log(error.name, error.message);
}
