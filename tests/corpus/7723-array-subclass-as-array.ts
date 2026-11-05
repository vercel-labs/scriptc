// A subclass instance passed where a plain array is expected is the same
// object: writes through either view are seen through the other, and
// species construction still applies in code typed with the plain array.
class Path extends Array<string> {
  label = "path";
}

function addSegment(parts: string[], segment: string): string[] {
  parts.push(segment);
  return parts.filter((part) => part.length > 0);
}

const p = new Path();
p.push("a", "", "b");
const filtered = addSegment(p, "c");
console.log(p.length, filtered.length, filtered instanceof Path, (filtered as Path).label);
const view: string[] = p;
view[0] = "z";
console.log(p[0], view === p, p.label);
console.log(p.map((s) => s.toUpperCase()));
console.log(Object.keys(p));
