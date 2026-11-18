// A function declaration the program replaces. Node's function declaration
// is a mutable binding, so the assignment replaces the callable and every
// later read and call sees the replacement. A named function expression's
// own inner binding is immutable: strict code throws there.
'use strict';

function compute(value) {
  return value * 2;
}
console.log(compute(2), typeof compute);
compute = function (value) {
  return value + 1;
};
console.log(compute(2), typeof compute);

function describe() {
  return "declared";
}
var snapshot = describe;
describe = function () {
  return "assigned";
};
console.log(describe(), snapshot(), describe === snapshot);

(function () {
  function nested() {
    return "nested";
  }
  console.log(nested());
  nested = function () {
    return "replaced";
  };
  console.log(nested());
})();

function recursive(n) {
  return n <= 0 ? 0 : n + recursive(n - 1);
}
console.log(recursive(4));
var original = recursive;
recursive = function (n) {
  return original(n) * 10;
};
console.log(recursive(4));

// A nested declaration the enclosing function reassigns with a function of
// another signature: Node's binding holds the replacement, so the call
// returns its value whatever the declaration's own signature says.
function nestedSignature() {
  function pick() {
    return 1;
  }
  const first = pick();
  pick = function () {
    return "text";
  };
  return first + ":" + pick() + ":" + typeof pick();
}
console.log(nestedSignature());

// A concise arrow forwarding the rebound binding's call answers the value the
// replacement returned, not the declaration's inferred result.
function forwarded() {
  function pick() {
    return 1;
  }
  const read = () => pick();
  pick = function () {
    return "text";
  };
  return read() + ":" + typeof read();
}
console.log(forwarded());
