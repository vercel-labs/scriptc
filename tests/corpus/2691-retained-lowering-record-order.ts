// Retained reachability lowers module inits before the function bodies they
// discover. Record metadata must still use the historical emit order: this
// function's {a,b} shape precedes the init's structurally-equal {b,a} shape.
function printFunctionRecord(): void {
  const value = { a: 1, b: 2 };
  console.log(Object.keys(value).join(","));
  console.log(JSON.stringify(value));
}

printFunctionRecord();
console.log(Object.keys({ b: 2, a: 1 }).length);
