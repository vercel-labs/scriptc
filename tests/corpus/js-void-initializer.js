"use strict";
// What a transpiler writes for `let v;`: a variable declared with `void 0`
// and assigned later. The binding holds whatever the writes store.
function pick(fn, n) {
  var val = void 0;
  try {
    val = fn(n);
  } catch (err) {
    return "caught " + err.message;
  }
  return val;
}
console.log(pick(function (n) { return "value " + n; }, 1));
console.log(pick(function (n) { return n + 41; }, 1));
console.log(pick(function () { throw new Error("thrown"); }, 1));
console.log(pick(function () {}, 1));

function last(list) {
  let found = void 0;
  for (const item of list) found = item;
  return found;
}
console.log(last(["a", "b"]), last([1, 2, 3]), last([]));

// Every kind of read, before and after the write.
function reads(fn, lexical) {
  var val = void 0;
  let held = void 0;
  const before = [typeof val, val === void 0, String(val), typeof held, held === undefined].join(",");
  try {
    val = fn(1);
    held = val;
  } catch (e) {
    return "caught";
  }
  if (lexical) val = held;
  const parts = [
    typeof val,
    val === void 0,
    val === undefined,
    val == null,
    val ? "truthy" : "falsy",
    String(val),
    "" + val,
    `${val}`,
    !val,
    val || "or",
    val ?? "nullish",
    JSON.stringify(val),
    JSON.stringify([val]),
    JSON.stringify({ v: val }),
    Array.isArray(val),
    val instanceof Error,
    val && val.length,
    val !== void 0 && val !== null ? Object.keys(Object(val)).length : -1,
  ];
  if (val) parts.push("if");
  if (val === void 0) parts.push("is-undefined");
  if (typeof val === "string") parts.push(val.toUpperCase());
  if (typeof val === "number") parts.push(val + 1);
  return before + "|" + parts.join(",");
}
for (const lexical of [false, true]) {
  console.log(reads(function () { return "text"; }, lexical));
  console.log(reads(function (n) { return n + 41; }, lexical));
  console.log(reads(function () { return [1, 2]; }, lexical));
  console.log(reads(function () { return { a: 1 }; }, lexical));
  console.log(reads(function () {}, lexical));
  console.log(reads(function () { return null; }, lexical));
  console.log(reads(function () { return 0; }, lexical));
  console.log(reads(function () { throw new Error("x"); }, lexical));
}

// Several declarators in one statement: the others keep their own types.
function several(input) {
  var first = void 0, count = 0, names = [], second = void 0, table = { hits: 0 };
  for (var i = 0; i < input.length; i++) {
    if (first === void 0) first = input[i];
    else second = input[i];
    count += 1;
    names.push(String(input[i]));
    table.hits++;
  }
  return [first, second, count, names.join("+"), table.hits].join(" ");
}
console.log(several(["a", 2, "c"]));
console.log(several([]));

// The head of a for statement, and a declaration a loop runs again.
function loops(limit) {
  const seen = [];
  for (var at = void 0, step = 1; (at = (at || 0) + step) <= limit; ) seen.push(at);
  for (let round = 0; round < 3; round++) {
    var fresh = void 0;
    let own = void 0;
    seen.push(String(fresh) + "/" + String(own));
    fresh = round;
    own = "r" + round;
    seen.push(fresh + "/" + own);
  }
  return seen.join(",");
}
console.log(loops(3));

// A module-level variable, assigned by a function.
var cached = void 0;
let count = void 0;
function load() {
  if (cached === void 0) {
    cached = { name: "loaded" };
    count = 0;
  }
  count++;
  return cached.name + " " + count;
}
console.log(typeof cached, typeof count);
console.log(load());
console.log(load());

// The value is handed on: a promise of what the write stored.
function later(fn) {
  return new Promise(function (resolve, reject) {
    var val = void 0;
    try {
      val = fn(1);
    } catch (err) {
      return reject(err);
    }
    Promise.resolve(val).then(resolve, reject);
  });
}
later(function (n) { return "value " + n; })
  .then(function (v) {
    console.log(v);
    return later(function () { return Promise.resolve(42); });
  })
  .then(function (v) {
    console.log(v);
    return later(function () { throw new Error("rejected"); });
  })
  .catch(function (e) {
    console.log("caught", e.message);
  });
