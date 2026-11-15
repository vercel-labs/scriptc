// @exit: 5
// The 'beforeExit' hook: it runs each time the loop runs out of ref'd work,
// with process.exitCode (0 while unset); ref'd work it schedules runs and
// draws another emission, while scheduled nextTicks and microtasks only run
// (they do not re-emit); `once` leaves the list before its call, listeners
// dispatch over a snapshot, and an exit code set in a listener is the one
// the second emission and the process exit see.
let rounds = 0;
process.on('beforeExit', (code) => {
  rounds++;
  console.log(`on ${rounds} code=${code} exitCode=${process.exitCode}`);
  if (rounds === 1) {
    process.exitCode = 5;
    process.nextTick(() => console.log('tick from beforeExit'));
    Promise.resolve().then(() => console.log('microtask from beforeExit'));
    setTimeout(() => console.log('timer from beforeExit'), 1);
  }
});
process.once('beforeExit', (code) => console.log(`once code=${code}`));
process.on('beforeExit', (code) => console.log(`second code=${code}`));
console.log('body done');
