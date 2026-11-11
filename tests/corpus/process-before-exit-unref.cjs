// Work scheduled from 'beforeExit' that does not ref the loop does not run:
// an unref'd timer never draws the next turn, while a ref'd immediate does,
// and that work's turn draws the next emission (the round guard keeps this
// finite: Node re-emits on every exhaustion while listeners remain).
let rounds = 0;
process.on('beforeExit', (code) => {
  rounds++;
  console.log(`beforeExit ${rounds} code=${code}`);
  if (rounds === 1) {
    // The delay is long enough that the timer cannot come due before the loop
    // exhausts: a 1 ms timer sometimes fires while the process is still alive
    // in this turn, so the program would print different lines from run to run.
    const timer = setTimeout(() => console.log('unref timer ran'), 1000);
    timer.unref();
    setImmediate(() => console.log('ref immediate ran'));
  }
});
console.log('body done');
