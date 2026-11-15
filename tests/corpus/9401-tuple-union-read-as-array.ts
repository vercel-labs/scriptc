// A row picked from an `as const` table whose rows differ in length has a
// union of tuple types. An assertion to one array type leaves the value as
// it is, so whatever consumes the assertion reads the tuple in place: the
// receiver of an array method, `.length`, an index, a `for…of`, a spread.
// No binding of the array type stands in between. (9403 pins that such a
// read sees writes; the methods that would write a tuple are refused in the
// diagnostics fixture tuple-union-array-in-place.)
const LINES = {
  harbour: ['pier', 'mill', 'depot'],
  hill: ['mast'],
  loop: ['gate', 'park', 'mill', 'quay'],
} as const;
type Line = keyof typeof LINES;
const lineNames = Object.keys(LINES) as Line[];

// Membership, with the row picked by its key.
function serves(line: Line, stop: string): boolean {
  return (LINES[line] as readonly string[]).includes(stop);
}
function linesThrough(stop: string): string {
  const hits = lineNames.filter((line) => serves(line, stop));
  return hits.length > 0 ? hits.join('+') : 'no line';
}
console.log(linesThrough('mill'), linesThrough('mast'), linesThrough('zoo'));

// Searches, with the row taken from the table's entries.
function locate(stop: string): string {
  const found: string[] = [];
  for (const [line, stops] of Object.entries(LINES)) {
    const at = (stops as readonly string[]).indexOf(stop);
    const fromEnd = (stops as readonly string[]).lastIndexOf(stop);
    const tested = (stops as readonly string[]).findIndex((s) => s === stop);
    const alike = (stops as readonly string[]).find((s) => s.charAt(0) === stop.charAt(0));
    const sameLength = (stops as readonly string[]).some((s) => s.length === stop.length);
    const allBefore = (stops as readonly string[]).every((s) => s < stop);
    found.push(`${line} ${at} ${fromEnd} ${tested} ${alike ?? '-'} ${sameLength} ${allBefore}`);
  }
  return found.join('; ');
}
console.log(locate('park'));
console.log(locate('mill'));
console.log(locate('zoo'));

// What a timetable prints of a row: its size, its ends, and copies of it.
function timetable(): void {
  for (const [line, stops] of Object.entries(LINES)) {
    const size = (stops as readonly string[]).length;
    console.log(
      line.toUpperCase(),
      size,
      (stops as readonly string[])[0],
      String((stops as readonly string[])[size - 1]),
      String((stops as readonly string[])[3]),
      (stops as readonly string[]).join(' > '),
      '|',
      (stops as readonly string[]).slice(1).join(' > '),
      '|',
      (stops as readonly string[]).map((s) => s.length * 2).join(''),
      (stops as readonly string[]).filter((s) => s.length > 4).join(','),
      (stops as readonly string[]).flatMap((s) => [s, s.toUpperCase()]).length,
      JSON.stringify(stops as readonly string[]),
      Array.isArray(stops as readonly string[]),
    );
  }
}
timetable();

// A loop and two spreads over the row.
function ride(line: Line, from: string): string {
  const passed: string[] = [];
  let aboard = false;
  for (const stop of LINES[line] as readonly string[]) {
    if (stop === from) aboard = true;
    if (aboard) passed.push(stop);
  }
  const withYard = [...(LINES[line] as readonly string[]), 'yard'];
  const sorted = [...(LINES[line] as unknown as string[])].sort();
  return `${passed.join('>')} (${withYard.length}) ${sorted.join('<')}`;
}
console.log(ride('loop', 'park'));
console.log(ride('hill', 'mast'));
console.log(ride('harbour', 'zoo'));

// Rows of numbers take the same path.
const FARES = { single: [3], day: [7, 11], week: [24, 30, 36] } as const;
function fareKinds(price: number): string {
  const out: string[] = [];
  for (const [kind, prices] of Object.entries(FARES)) {
    out.push(
      kind + ((prices as readonly number[]).includes(price) ? '*' : '') + (prices as readonly number[]).indexOf(price),
      (prices as readonly number[]).join('/') + '#' + (prices as readonly number[]).length,
    );
  }
  return out.join(' ');
}
console.log(fareKinds(11), '|', fareKinds(36), '|', fareKinds(5), '|', fareKinds(NaN));

// So do rows that mix strings, numbers and booleans.
const SIGNS = { door: ['push', 2], lift: [false], exit: ['left', 'up', 9] } as const;
function signsWith(mark: string | number | boolean): string {
  const out: string[] = [];
  for (const [place, sign] of Object.entries(SIGNS)) {
    if ((sign as readonly (string | number | boolean)[]).includes(mark)) out.push('@' + place);
    out.push(
      String((sign as readonly (string | number | boolean)[]).indexOf(mark)),
      (sign as readonly (string | number | boolean)[]).join('·'),
    );
  }
  return out.join(' ');
}
console.log(signsWith('up'), '|', signsWith(9), '|', signsWith(false), '|', signsWith('pull'));

// A row that may be missing keeps its `undefined`.
function maybeServes(line: string, stop: string): string {
  const rows = LINES as Record<string, (typeof LINES)[Line] | undefined>;
  const stops = rows[line];
  return String((stops as readonly string[] | undefined)?.includes(stop));
}
console.log(maybeServes('loop', 'quay'), maybeServes('loop', 'pier'), maybeServes('ring', 'quay'));
