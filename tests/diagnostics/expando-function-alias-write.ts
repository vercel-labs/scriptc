// A function expando member lives in a module global keyed by the DECLARING
// symbol, and reads through the function's name answer from that slot. A
// write through an alias of the same function cannot reach it, so the write
// stays fenced instead of leaving the next read through the name answering
// the old value where Node answers the new one.
function counter(): number {
  return 0;
}
counter.count = 1;
const alias = counter;
alias.count = 2;
console.log(counter.count);
// End of the function expando alias write diagnostic fixture.
