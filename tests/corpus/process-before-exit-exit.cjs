// @exit: 3
// process.exit() inside a 'beforeExit' listener exits at once: the rest of
// the snapshot does not run, the 'exit' event still does, and the code it
// passed (or process.exitCode, when bare) is the process's.
process.on('beforeExit', (code) => {
  console.log('beforeExit first', code);
  process.exit(3);
});
process.on('beforeExit', () => console.log('second listener must not run'));
process.on('exit', (code) => console.log('exit', code));
console.log('body done');
