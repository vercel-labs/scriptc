// The members of a union that share a discriminant literal are stored as one record. A value whose
// type is not one of those members but has the properties of one (an inferred literal type, the
// member written out a second time, the type an assertion names) is built as that record too: it
// enters the union at every site as the object it is, so writes through either name reach it and
// `===` holds, as under Node.
type Book = { kind: "print"; title: string };
type Loan = { kind: "print"; title: string; reader: string };
type Tape = { kind: "audio"; minutes: number };
type Entry = Book | Loan | Tape;

function show(entry: Entry): string {
  if (entry.kind === "audio") return "tape " + entry.minutes;
  return "reader" in entry ? "loan " + entry.title + " to " + entry.reader : "book " + entry.title;
}

// An inferred literal type with a book's properties, at each site that stores it.
const atlas = { kind: "print" as const, title: "atlas" };
const bound: Entry = atlas;
function keep(entry: Entry): Entry {
  return entry;
}
function give(): Entry {
  return atlas;
}
const shelf: Entry[] = [];
shelf.push(atlas);
const slot: { entry: Entry } = { entry: atlas };
const asserted = atlas as Entry;
console.log(JSON.stringify(bound), Object.keys(bound).join(","), show(bound));
console.log(bound === atlas, keep(atlas) === atlas, give() === atlas, shelf[0] === atlas);
console.log(slot.entry === atlas, asserted === atlas, shelf.indexOf(atlas));

// A write through the union reaches the binding, and a write through the binding the union.
if (bound.kind === "print") bound.title = "atlas, second edition";
console.log(atlas.title);
atlas.title = "atlas, third edition";
console.log(JSON.stringify(shelf[0]), JSON.stringify(slot.entry), show(give()));
function retitle(a: Entry, b: Entry): string {
  if (a.kind === "print") a.title = "retitled";
  return String(a === b) + " " + show(b);
}
console.log(retitle(bound, atlas), atlas.title);

// The properties of the wider member: the same object, and its own member reads back.
const lent = { kind: "print" as const, title: "primer", reader: "ada" };
const lentEntry: Entry = lent;
console.log(lentEntry === lent, show(lentEntry), lent.reader.length, Object.keys(lent).join(","));
if (lentEntry.kind === "print" && "reader" in lentEntry) lentEntry.reader = "grace";
console.log(lent.reader, JSON.stringify(lent));

// The member's type written a second time, a literal under `as const`, a function's inferred
// result, and a parsed value asserted to a type written in place.
type Volume = { kind: "print"; title: string };
const volume: Volume = { kind: "print", title: "volume" };
const fixed = { kind: "print", title: "fixed" } as const;
function make() {
  return { kind: "print" as const, title: "made" };
}
const made = make();
const parsed = JSON.parse('{"kind":"print","title":"parsed"}') as { kind: "print"; title: string };
const mixed: Entry[] = [volume, fixed, made, parsed, { kind: "audio", minutes: 40 }];
console.log(mixed[0] === volume, mixed[1] === fixed, mixed[2] === made, mixed[3] === parsed);
volume.title = "volume two";
made.title = "made again";
parsed.title = "parsed again";
for (const entry of mixed) console.log(show(entry), JSON.stringify(entry), Object.keys(entry).join(","));
const titles = new Set<Entry>([volume, made]);
console.log(titles.has(mixed[0]!), titles.has(mixed[2]!), titles.has(mixed[3]!));

// A spread is a copy in both worlds: another object, with its own properties.
const copied: Entry = { ...atlas };
console.log(copied === atlas, JSON.stringify(copied));
if (copied.kind === "print") copied.title = "copy";
console.log(atlas.title, show(copied));

// The same member written in a second union: one record in both unions, so a value of the first
// union's member is the same object in the second.
type Reprint = { kind: "print"; title: string };
type Signed = { kind: "print"; title: string; signer: string };
type Poster = { kind: "sheet"; width: number };
type Stock = Reprint | Signed | Poster;
const shared: Book = { kind: "print", title: "shared" };
const inStock: Stock = shared;
const inCatalogue: Entry = shared;
if (inStock.kind === "print") inStock.title = "shared, restocked";
console.log(inStock === shared, inCatalogue === shared, shared.title, JSON.stringify(inCatalogue));
const signed: Signed = { kind: "print", title: "signed", signer: "eve" };
const stock: Stock[] = [signed, shared, { kind: "sheet", width: 2 }];
for (const item of stock) {
  console.log(JSON.stringify(item), Object.keys(item).join(","), "signer" in item, "reader" in item);
}
console.log(stock.indexOf(shared), stock[0] === signed, show(shared));
