// CommonJS: module-level state that an initializer function assigns, and
// locals a nested function assigns, read after the call. The read is the
// stored value in every position, including arguments of a constructor
// function's methods and of library functions with optional parameters.
"use strict";

var path = require("node:path");

function Table(name) {
  this.name = name;
  this.rows = [];
}
Table.prototype.add = function (key, value) {
  this.rows.push(String(key) + "=" + typeof value + ":" + String(value));
  return this;
};
Table.prototype.describe = function (separator) {
  return this.name + "[" + this.rows.join(separator) + "]";
};

var settings;
var limit;
var prefix = undefined;
var fallback = null;
function configure() {
  settings = { width: 4, pad: "." };
  limit = 2;
  prefix = "p";
  fallback = "f";
}
configure();

function widthOf(value) {
  return value.width;
}
function padOf(value) {
  return value.pad;
}

var table = new Table("module");
table.add("settings", widthOf(settings)).add("limit", limit).add("prefix", prefix).add("fallback", fallback);
console.log(table.describe());
console.log(table.describe(prefix));
console.log("abcdef".slice(limit), "abab".lastIndexOf("b", limit), "7".padStart(widthOf(settings), padOf(settings)));
console.log(Number(limit) + 1, String(prefix) + String(fallback), parseInt("101", limit));
console.log(path.join("a", prefix, fallback), path.basename("dir/file.txt", prefix));

function collect(words) {
  var longest, total, first;
  function visit(word, index) {
    if (index === 0) first = word;
    if (longest === undefined || word.length > longest.length) longest = word;
    total = (total || 0) + word.length;
  }
  words.forEach(visit);
  var local = new Table("collect");
  local.add("longest", longest).add("total", total).add("first", first);
  return local.describe("; ") + " " + "0123456789".slice(total) + " " + String(longest) + (longest ? "/" : "?") + String(first);
}
console.log(collect(["bb", "a", "ccc"]));
console.log(collect([]));

function lazy() {
  var cache;
  var hits = 0;
  function load() {
    cache = ["x", "y", "z"];
  }
  function get(index) {
    if (cache === undefined) load();
    hits = hits + 1;
    return cache[index];
  }
  var a = get(1);
  var b = get(2);
  return new Table("lazy").add("a", a).add("b", b).add("hits", hits).describe(a);
}
console.log(lazy());

exports.Table = Table;
exports.collect = collect;
console.log(typeof exports.collect, typeof exports.Table);
