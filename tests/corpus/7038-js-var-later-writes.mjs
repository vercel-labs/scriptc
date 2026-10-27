// JavaScript `var` and `let` bindings that later hold another type than
// their initializer's, which nothing checks in a JavaScript file: Node
// runs each write, and a function returning the binding returns what it
// holds.
function retyped(input) {
  var value = 0;
  value = input.slice(0, 2);
  return value;
}

function padded(digits) {
  var fraction = 0;
  if (digits) {
    fraction = digits.slice(0, 3);
    while (fraction.length < 3) fraction += "0";
    fraction = +fraction;
  }
  return fraction + 1;
}

function suffixed(n) {
  var width = n * 2;
  width += "px";
  return width;
}

function letRetyped(record) {
  let current = 1;
  current = record.name;
  return current;
}

function grown(line) {
  var mark = { line: line, column: line - 1 };
  mark.text = "at " + (mark.line + 1);
  return mark;
}

async function awaitedTotal(values) {
  var total = 0;
  for (var i = 0; i < values.length; i++) total += await values[i];
  console.log("awaited", total, typeof total);
  return total;
}

function counted(values) {
  var count = 0;
  for (var i = 0; i < values.length; i++) count += values[i];
  return count;
}

console.log(retyped("abc"), typeof retyped("abc"));
console.log(padded("5"), padded("12345"), padded(""));
console.log(suffixed(4), typeof suffixed(4));
console.log(letRetyped({ name: "x" }), letRetyped({ name: 2 }));
console.log(JSON.stringify(grown(3)), Object.keys(grown(0)).join(","));
console.log(counted([1, 2]), counted([1, "a", 2]));
await awaitedTotal([1, Promise.resolve(2)]);
await awaitedTotal([1, Promise.resolve("b")]);
