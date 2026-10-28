// A `with` resolves names against the record it is given, then falls back
// to the enclosing scope when the record has no such property.
var greeting = "hello";

function describe(record) {
  with (record) {
    return greeting + " " + first + " " + last;
  }
}

function fallback(record) {
  with (record) {
    return typeof first === "string" ? first : "nobody";
  }
}

function shadowed() {
  var first = "outer";
  with ({ first: "inner" }) {
    return first + "/" + arguments.length;
  }
}

function nested(record) {
  with (record) {
    with (outer) {
      return inner;
    }
  }
}

module.exports = { describe, fallback, shadowed, nested };
