// The values of an `as const` table are tuples of different lengths, so a
// value picked from it is a union of tuple types. Read through an
// assertion to one array type, the value is the receiver of array methods,
// of `.length` and an index, of a loop and of a spread, without a binding
// of the array type in between. Each read is of the value itself (9403
// shows that with writes); the methods a tuple cannot run in place are in
// the diagnostics fixture tuple-union-array-in-place.
const GROUPS = {
  'Fruit and Nuts': ['apple', 'pear', 'walnut'],
  Vegetables: ['kale'],
  Grains: ['rye', 'oat', 'rice', 'millet'],
} as const;

function groupOf(name: string, fallback = 'Everything Else'): string {
  return (
    Object.entries(GROUPS).find(([, names]) =>
      (names as readonly string[]).includes(name)
    )?.[0] ?? fallback
  );
}
console.log(groupOf('kale'), '|', groupOf('millet'), '|', groupOf('fig'));

function searches(name: string): string {
  const out: string[] = [];
  for (const [group, names] of Object.entries(GROUPS)) {
    out.push(
      group.length +
        ':' +
        (names as readonly string[]).indexOf(name) +
        ',' +
        (names as readonly string[]).lastIndexOf(name) +
        ',' +
        (names as readonly string[]).findIndex((x) => x === name) +
        ',' +
        String((names as readonly string[]).find((x) => x.startsWith(name.slice(0, 2)))) +
        ',' +
        (names as readonly string[]).some((x) => x === name) +
        ',' +
        (names as readonly string[]).every((x) => x !== name),
    );
  }
  return out.join(' ');
}
console.log(searches('oat'));
console.log(searches('pear'));
console.log(searches('fig'));

function shapes(): string {
  const out: string[] = [];
  Object.entries(GROUPS).forEach(([, names]) => {
    out.push(
      [
        (names as readonly string[]).length,
        (names as readonly string[])[0],
        String((names as readonly string[])[3]),
        (names as readonly string[]).join('+'),
        (names as readonly string[]).slice(1).join('+'),
        (names as readonly string[]).map((x) => x.length).join(''),
        (names as readonly string[]).filter((x) => x.length > 3).join('+'),
        (names as readonly string[]).flatMap((x) => [x, x]).length,
        JSON.stringify(names as readonly string[]),
        Array.isArray(names as readonly string[]),
      ].join(' '),
    );
  });
  return out.join('\n');
}
console.log(shapes());

function walks(name: string): string {
  const out: string[] = [];
  for (const [group, names] of Object.entries(GROUPS)) {
    for (const x of names as readonly string[]) if (x === name) out.push(x + '@' + group);
    out.push([...(names as readonly string[]), 'end'].length.toString());
    out.push([...(names as unknown as string[])].sort().join('<'));
  }
  return out.join(' ');
}
console.log(walks('rice'));
console.log(walks('kale'));

// Tables of numbers and of mixed values take the same path.
const SIZES = { small: [1, 2], large: [10, 20, 30], one: [7] } as const;
function sized(n: number): string {
  const out: string[] = [];
  for (const [key, values] of Object.entries(SIZES)) {
    if ((values as readonly number[]).includes(n)) out.push(key);
    out.push(
      String((values as readonly number[]).indexOf(n)),
      (values as readonly number[]).join('-'),
      String((values as readonly number[]).length),
    );
  }
  return out.join(',');
}
console.log(sized(2), '|', sized(30), '|', sized(5), '|', sized(NaN));

const ROWS = { a: ['x', 1], b: [true], c: ['y', 'z', 2] } as const;
function scan(v: string | number | boolean): string {
  const out: string[] = [];
  for (const [key, row] of Object.entries(ROWS)) {
    if ((row as readonly (string | number | boolean)[]).includes(v)) out.push(key);
    out.push(
      String((row as readonly (string | number | boolean)[]).indexOf(v)),
      (row as readonly (string | number | boolean)[]).join('/'),
    );
  }
  return out.join(',');
}
console.log(scan('x'), '|', scan(2), '|', scan(true), '|', scan('q'));

// An optional value of the table keeps its `undefined`.
function has(key: string, name: string): string {
  const table = GROUPS as Record<string, (typeof GROUPS)[keyof typeof GROUPS] | undefined>;
  const names = table[key];
  return String((names as readonly string[] | undefined)?.includes(name));
}
console.log(has('Grains', 'oat'), has('Grains', 'fig'), has('Nope', 'oat'));
