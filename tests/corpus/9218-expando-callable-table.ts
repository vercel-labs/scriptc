// Expando members on a function declaration are own properties of the
// function object, not separate storage: a write through any alias of the
// same function lands on one table, Object.keys enumerates them, and the
// value stays callable.
function counter(): number {
  counter.calls++;
  return counter.calls;
}
counter.calls = 0;
counter.label = "ctr";
counter();
counter();
const alias = counter;
alias.calls += 10;
console.log(counter.calls, alias.label, Object.keys(counter), typeof counter, alias === counter);
