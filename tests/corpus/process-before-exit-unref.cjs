// Work scheduled from 'beforeExit' that does not ref the loop does not run:
// an unref'd timer never draws the next turn, while a ref'd immediate does,
// and that work's turn draws the next emission (the round guard keeps this
// finite: Node re-emits on every exhaustion while listeners remain).
let rounds = 0;
process.on('beforeExit', (code) => {
  rounds++;
  console.log(`beforeExit ${rounds} code=${code}`);
  if (rounds === 1) {
    const timer = setTimeout(() => console.log('unref timer ran'), 1);
    timer.unref();
    setImmediate(() => console.log('ref immediate ran'));
  }
});
console.log('body done');
