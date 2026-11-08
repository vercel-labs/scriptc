// The values of an `as const` table used as they are, with no assertion:
// a union of tuples whose elements have one type answers the array
// methods, a loop and a spread as one array of that type does, each arm
// read in place.
const LINES = {
  harbour: ['pier', 'mill', 'depot'],
  hill: ['mast'],
  loop: ['gate', 'park', 'mill', 'quay'],
} as const;

type Stop = (typeof LINES)[keyof typeof LINES][number];

function lengths(key: keyof typeof LINES): number {
  let n = 0;
  for (const stop of LINES[key]) n += stop.length;
  return n;
}
console.log(lengths('hill'), lengths('loop'), lengths('harbour'));
console.log(LINES.harbour.includes('mill'), LINES.hill.join('+'));

function find(stop: Stop): string {
  const out: string[] = [];
  for (const [line, stops] of Object.entries(LINES)) {
    if (stops.includes(stop as never)) out.push(line);
    out.push(
      String(stops.indexOf(stop as never)),
      String(stops.lastIndexOf(stop as never)),
      String(stops.findIndex((x) => x === stop)),
      String(stops.find((x) => x === stop)),
      String(stops.some((x) => x === stop)),
      String(stops.every((x) => x !== stop)),
      stops.join('+'),
      stops.slice(1).join('+'),
      stops.map((x) => x.length).join(''),
      stops.filter((x) => x.length > 3).join('+'),
      String(stops.flatMap((x) => [x, x]).length),
    );
    for (const x of stops) if (x === stop) out.push(x + '!');
    out.push([...stops, 'end'].join('+'));
  }
  return out.join(' ');
}
console.log(find('mast'));
console.log(find('quay'));
console.log(find('pier'));
