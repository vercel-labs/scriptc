// util.diff over strings (one entry per UTF-16 code unit, astral pairs as
// two) and arrays of strings: Node's Myers diff entries in order, identical
// values answering [] before validation, and ERR_INVALID_ARG_TYPE naming
// the argument or the array element.
const util = require("util");
const show = (a, e) => {
  try { console.log(JSON.stringify(util.diff(a, e))); } catch (err) { console.log(err.name, err.code, err.message); }
};
show("abc", "abd"); show("kitten", "sitting"); show("", "x"); show("same", "same"); show("", "");
show(["a", "b", "c"], ["a", "c", "d"]); show(["x"], []); show([], ["y", "z"]); show([], []);
const arr = ["p"]; show(arr, arr); show(1, 1); show(1, 2); show("a", 2); show(["a", 1], ["a"]); show(["a"], [, "b"]);
show(null, "x"); show("x", undefined); show("héllo😀", "hello😀"); show({}, "x");
show("the quick brown fox", "the quack brown box");
console.log(util.diff(["line 1", "line 2"], ["line 1", "line 3"]));
