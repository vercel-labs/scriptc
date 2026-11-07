// The JavaScript twin of 8887-function-inherited-member-values.ts: a
// function's inherited `call`, `bind` and `toString` read as values, and a
// deleted own property reveals the inherited member again.
function pass(value) {
  return value;
}
var add = pass(function (a, b) {
  return a + b;
});

console.log("typeof", typeof add.call, typeof add.apply, typeof add.bind, typeof add.toString);
console.log("own", Object.prototype.hasOwnProperty.call(add, "call"), "call" in add);

var call = add.call;
var bind = add.bind;
console.log("held", call.call(add, null, 1, 2), bind.call(add, null, 3)(4));

add.call = function () {
  return "own call";
};
console.log("shadow", typeof add.call, add.call());
delete add.call;
console.log("deleted", typeof add.call, add.call(null, 5, 6), Object.keys(add).join(","));

add.bind = 1;
delete add.bind;
console.log("re-deleted", typeof add.bind, add.bind(null, 7)(8));

// The inherited `call` runs any callable it is called on, a Proxy included,
// and a bracket key reads the same member.
var proxied = new Proxy(
  function (a, b) {
    return a * b;
  },
  {},
);
console.log("proxy receiver", call.call(proxied, null, 6, 7));
console.log("bracket", typeof add["call"], typeof add["bind"], add["call"] === call);
