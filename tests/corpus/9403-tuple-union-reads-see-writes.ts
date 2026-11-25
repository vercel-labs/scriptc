// A union of tuples read as one array is read in place. What a callback, a
// loop body, an argument or an index expression writes to the tuple while
// the read runs is what the read sees, as on one array: a copy made when
// the receiver was evaluated would answer the old elements.
type Row = [string, string] | [string, string, string];
const two: [string, string] = ['a', 'b'];
const three: [string, string, string] = ['c', 'd', 'e'];
function pick(which: number): Row {
  return which === 0 ? two : three;
}
function reset(): void {
  two[0] = 'a';
  two[1] = 'b';
  three[0] = 'c';
  three[1] = 'd';
  three[2] = 'e';
}

function run(which: number): void {
  const row = pick(which);
  // Writes the last position of the tuple `row` is.
  const write = (value: string): string => {
    if (which === 0) two[1] = value;
    else three[2] = value;
    return value;
  };
  const last = which === 0 ? 1 : 2;

  reset();
  console.log(
    'map',
    (row as readonly string[])
      .map((x, i) => {
        if (i === 0) write('Y');
        return x;
      })
      .join(','),
  );

  reset();
  const looped: string[] = [];
  for (const x of row as readonly string[]) {
    write('X');
    looped.push(x);
  }
  console.log('for-of', looped.join(','));

  reset();
  const bump = (): number => {
    write('W');
    return last;
  };
  console.log('index', (row as readonly string[])[bump()], String((row as readonly string[])[9]));

  reset();
  console.log(
    'some',
    (row as readonly string[]).some((x, i) => {
      if (i === 0) write('S');
      return x === 'S';
    }),
    'every',
    (row as readonly string[]).every((x, i) => {
      if (i === 0) write('E');
      return x !== 'E';
    }),
  );

  reset();
  console.log(
    'find',
    String(
      (row as readonly string[]).find((x, i) => {
        if (i === 0) write('F');
        return x === 'F';
      }),
    ),
    (row as readonly string[]).findIndex((x, i) => {
      if (i === 0) write('G');
      return x === 'G';
    }),
  );

  reset();
  console.log(
    'filter',
    (row as readonly string[])
      .filter((x, i) => {
        if (i === 0) write('K');
        return i > 0;
      })
      .join(','),
    (row as readonly string[])
      .flatMap((x, i) => {
        if (i === 0) write('M');
        return [x, x];
      })
      .join(''),
  );

  reset();
  console.log(
    'search',
    (row as readonly string[]).includes(write('N')),
    (row as readonly string[]).indexOf(write('O')),
    (row as readonly string[]).lastIndexOf(write('P')),
  );

  reset();
  console.log(
    'join',
    (row as readonly string[]).join(write('+')),
    (row as readonly string[]).slice(write('L').length).join(','),
  );

  reset();
  console.log(
    'length',
    write('Q').length + (row as readonly string[]).length,
    [write('R'), ...(row as readonly string[])].join(','),
  );
}
run(0);
run(1);

// The same value with no assertion.
function plain(which: number): void {
  const row = pick(which);
  const write = (value: string): string => {
    if (which === 0) two[1] = value;
    else three[2] = value;
    return value;
  };
  reset();
  console.log(
    'plain map',
    row
      .map((x, i) => {
        if (i === 0) write('Y');
        return x;
      })
      .join(','),
  );
  reset();
  const looped: string[] = [];
  for (const x of row) {
    write('X');
    looped.push(x);
  }
  console.log('plain for-of', looped.join(','), row.includes(write('N')), row.join(write('-')));
}
plain(0);
plain(1);
