// Direct process.stdout.destroyed / process.stderr.destroyed reads answer
// false like Node's special streams, before and after destroy(), in the
// String(), typeof and strict-equality forms: never undefined or a number.
// Node is the oracle.
console.log(
  "out:",
  String(process.stdout.destroyed),
  typeof process.stdout.destroyed,
  process.stdout.destroyed === false
);
console.log(
  "err:",
  String(process.stderr.destroyed),
  process.stderr.destroyed === false,
  typeof process.stderr.destroyed
);
process.stderr.destroy();
process.stdout.destroy();
console.log(
  "after:",
  String(process.stderr.destroyed),
  process.stderr.destroyed === false,
  String(process.stdout.destroyed),
  process.stdout.destroyed === false
);
