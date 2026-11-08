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

function find(name: Stop): string {
  const out: string[] = [];
  for (const [group, names] of Object.entries(LINES)) {
    if (names.includes(name as never)) out.push(group);
    out.push(
      String(names.indexOf(name as never)),
      String(names.lastIndexOf(name as never)),
      String(names.findIndex((x) => x === name)),
      String(names.find((x) => x === name)),
      String(names.some((x) => x === name)),
      String(names.every((x) => x !== name)),
      names.join('+'),
      names.slice(1).join('+'),
      names.map((x) => x.length).join(''),
      names.filter((x) => x.length > 3).join('+'),
      String(names.flatMap((x) => [x, x]).length),
    );
    for (const x of names) if (x === name) out.push(x + '!');
    out.push([...names, 'end'].join('+'));
  }
  return out.join(' ');
}
console.log(find('mast'));
console.log(find('quay'));
console.log(find('pier'));
