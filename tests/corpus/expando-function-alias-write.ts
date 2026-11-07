// A function's expando member is an own property of the function object
// (the closure's property table), so a write through an alias of the same
// function is the write Node makes: the next read through the function's
// own name answers the new value.
function counter(): number {
  return 0;
}
counter.count = 1;
const alias = counter;
alias.count = 2;
console.log(counter.count, alias.count, alias === counter);
alias.count += 3;
console.log(counter.count, Object.keys(counter).join(","));
