// Statements after return, throw, break or continue never run, while the
// declarations among them keep their hoisting: a later function declaration
// is callable from above, a later `var` reads undefined, and a later
// `let`/`const` stays in its temporal dead zone.
function hoistedCall(): number {
  return twice(21);
  console.log('never');
  function twice(n: number): number {
    return n * 2;
  }
}

function hoistedVar(): string {
  const before = typeof late;
  return before;
  var late: string | undefined = 'assigned';
  console.log(late);
}

function deadZone(): string {
  const read = (): number => counted;
  try {
    return String(read());
  } catch (error) {
    return (error as Error).name + ': ' + (error as Error).message;
  }
  const counted = 1;
}

function closureReference(): number {
  const call = (): number => helper();
  return call();
  function helper(): number {
    return 7;
  }
}

function loops(): string {
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    if (i === 1) {
      seen.push('skip');
      continue;
      seen.push('never');
    }
    if (i === 3) {
      seen.push('stop');
      break;
      seen.push('never');
    }
    seen.push('i' + i);
  }
  return seen.join(',');
}

function cases(n: number): string {
  switch (n) {
    case 0:
      return 'zero';
      console.log('never');
    case 1:
      n += 10;
    case 2:
      return 'fell to ' + n;
    default:
      throw new RangeError('n=' + n);
      console.log('never');
  }
}

function stub(): string {
  throw new Error('stub');
  const unused = [1, 2, 3].map((x) => x * 2);
  return unused.join();
}

console.log(hoistedCall(), hoistedVar(), deadZone(), closureReference(), loops());
console.log(cases(0), cases(1), cases(2));
for (const run of [() => cases(5), stub]) {
  try {
    run();
  } catch (error) {
    console.log((error as Error).name, (error as Error).message);
  }
}
