// A constructor declared inside another function returns an object, and the
// object replaces the receiver just as it does at the top level.
function Outer() {
  function Maker() {
    const n = 1;
    return { get: function () { return n; } };
  }
  return new Maker().get();
}
console.log(Outer());

// Returning an object replaces the receiver; returning nothing keeps it.
function choose() {
  function Maker(flag) {
    if (flag) return { tag: "returned" };
    this.tag = "receiver";
  }
  return new Maker(true).tag + "," + new Maker(false).tag;
}
console.log(choose());
