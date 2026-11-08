// A generic function iterates its type parameter as the constraint's
// elements, while each instantiation stores its own element records. When
// the array is not proven dense the loop variable also carries a hidden
// hole arm. Member reads go through the stored records, and a hole fails
// the read with the TypeError Node reports.

interface Segment {
  trail: string;
  grade: number | null;
  closed: boolean;
  warden?: string;
}

const paved = [
  { trail: "ridge", grade: null, closed: false },
  { trail: "creek", grade: 4, closed: true, warden: "Ines" },
];

// Written out of order: full when read, but never proven dense.
const reordered: typeof paved = [];
reordered[1] = paved[1]!;
reordered[0] = paved[0]!;

// A real hole at 0 and 1.
const washedOut: typeof paved = [];
washedOut[2] = paved[1]!;

const surveyed = [...paved, { trail: "summit", grade: 9, closed: false, cairns: 12 }];
const resurveyed: typeof surveyed = [];
resurveyed[2] = surveyed[2]!;
resurveyed[0] = surveyed[0]!;
resurveyed[1] = surveyed[1]!;

function attempt(run: () => string): string {
  try {
    return run();
  } catch (error) {
    return error instanceof TypeError ? `TypeError: ${error.message}` : `other: ${String(error)}`;
  }
}

function summary<T extends ReadonlyArray<Segment>>(segments: T): string {
  const lines: string[] = [];
  for (const segment of segments) {
    lines.push(
      segment.trail +
        (segment.grade ? `/${segment.grade}` : "") +
        (segment.warden ?? "") +
        (segment.closed ? "!" : ""),
    );
  }
  return lines.join(",");
}

function wardens<T extends ReadonlyArray<Segment>>(segments: T): string {
  const lines: string[] = [];
  for (const segment of segments) {
    const later = (): string => segment.trail.toUpperCase() + String(segment.grade ?? "-");
    lines.push(later());
  }
  for (const segment of segments) {
    if (segment.warden) lines.push(segment.warden.slice(0, 2));
    lines.push(segment.warden?.length.toString() ?? "~");
  }
  return lines.join(",");
}

function holes<T extends ReadonlyArray<Segment>>(segments: T): string {
  const lines: string[] = [];
  for (const segment of segments) {
    if (segment === undefined) {
      lines.push("hole");
      continue;
    }
    lines.push(`${typeof segment}:${segment.trail}`);
  }
  return lines.join(",");
}

type Marker =
  | { kind: "post"; trail: string; height: number }
  | { kind: "sign"; trail: string; faded: boolean };

const markers: Marker[] = [];
markers[1] = { kind: "sign", trail: "creek", faded: true };
markers[0] = { kind: "post", trail: "ridge", height: 2 };

function inventory<T extends ReadonlyArray<Marker>>(items: T): string {
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === "post") lines.push(`${item.trail}=${item.height}`);
    else lines.push(item.trail + (item.faded ? " faded" : " clear"));
  }
  return lines.join(",");
}

console.log(attempt(() => summary(paved)));
console.log(attempt(() => summary(reordered)));
console.log(attempt(() => summary(washedOut)));
console.log(attempt(() => summary(resurveyed)));
console.log(attempt(() => wardens(reordered)));
console.log(attempt(() => wardens(washedOut)));
console.log(attempt(() => holes(reordered)));
console.log(attempt(() => holes(washedOut)));
console.log(attempt(() => inventory(markers)));
resurveyed[5] = surveyed[0]!;
console.log(attempt(() => summary(resurveyed)));
