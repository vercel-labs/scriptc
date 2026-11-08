// A property a base constructor adds to an error exists before the
// subclass's fields do, so every listing has it between the base's fields
// and the subclass's.
class Reading extends Error {
  station = "s1";
  constructor(message: string) {
    super(message);
    (this as any).source = "probe";
  }
}

class Frost extends Reading {
  depth = 2;
  crop = "kale";
}

class Hail extends Frost {
  size = 9;
  constructor(message: string) {
    super(message);
    (this as any).seen = "dawn";
  }
}

function listed(value: unknown): string {
  const error = value as object;
  return `${Object.keys(error).join(",")} | ${JSON.stringify(error)} | ${Object.getOwnPropertyNames(error).join(",")}`;
}

const frost = new Frost("frost");
console.log(Object.keys(frost).join(","));
console.log(JSON.stringify(frost));
console.log(Object.getOwnPropertyNames(frost).join(","));
console.log(listed(frost));

// A property added after construction follows them all.
(frost as any).noted = true;
frost.cause = "clear sky";
console.log(listed(frost));
console.log(frost.depth, frost.crop, frost.station, (frost as any).source, (frost as any).noted);

// Three levels: each constructor's addition sits after the fields that
// existed when it ran.
const hail = new Hail("hail");
console.log(listed(hail));
console.log(Object.entries(hail).map(([key, value]) => `${key}:${String(value)}`).join(" "));

// An instance of the base class itself has no subclass fields.
const reading = new Reading("reading");
console.log(listed(reading));

// A field written after construction keeps its place.
frost.depth = 5;
hail.size = 1;
console.log(Object.keys(frost).join(","), frost.depth, Object.keys(hail).join(","), hail.size);
