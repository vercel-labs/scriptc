// A generic loop variable that stores several record shapes and a hidden
// hole arm reads named members through the stored records. A keyed read
// and a receiver the checker narrowed or an assertion renamed still name
// one record the storage does not prove: they stay refused.

interface Segment {
  trail: string;
  grade: number | null;
  warden?: string;
}

const paved = [
  { trail: "ridge", grade: null },
  { trail: "creek", grade: 4, warden: "Ines" },
];
const reordered: typeof paved = [];
reordered[1] = paved[1]!;
reordered[0] = paved[0]!;

function hasWarden<S extends Segment>(segment: S): segment is S & { warden: string } {
  return typeof segment.warden === "string";
}

function keyed<T extends ReadonlyArray<Segment>>(segments: T): string[] {
  const lines: string[] = [];
  for (const segment of segments) lines.push(String(segment["grade"]));
  return lines;
}

function narrowed<T extends ReadonlyArray<Segment>>(segments: T): string[] {
  const lines: string[] = [];
  for (const segment of segments) {
    if (hasWarden(segment)) lines.push(segment.warden);
  }
  return lines;
}

function asserted<T extends ReadonlyArray<Segment>>(segments: T): string[] {
  const lines: string[] = [];
  for (const segment of segments) lines.push((segment as Segment).trail);
  return lines;
}

console.log(keyed(reordered), narrowed(reordered), asserted(reordered));
