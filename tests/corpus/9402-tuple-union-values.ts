// The values of an `as const` table used as they are, with no assertion:
// a union of tuples whose elements have one type answers the array
// methods, a loop and a spread as one array of that type does, each arm
// read in place.
const GROUPS = {
  'Fruit and Nuts': ['apple', 'pear', 'walnut'],
  Vegetables: ['kale'],
  Grains: ['rye', 'oat', 'rice', 'millet'],
} as const;

type Name = (typeof GROUPS)[keyof typeof GROUPS][number];

function lengths(key: keyof typeof GROUPS): number {
  let n = 0;
  for (const name of GROUPS[key]) n += name.length;
  return n;
}
console.log(lengths('Vegetables'), lengths('Grains'), lengths('Fruit and Nuts'));
console.log(GROUPS['Fruit and Nuts'].includes('pear'), GROUPS.Vegetables.join('+'));

function find(name: Name): string {
  const out: string[] = [];
  for (const [group, names] of Object.entries(GROUPS)) {
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
console.log(find('kale'));
console.log(find('millet'));
console.log(find('apple'));
