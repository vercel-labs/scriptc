// The value Object.assign(target, source) answers is the target itself: a
// binding of the result and the target are one object, so a write through
// either is read through the other. The source supplies members the target's
// type leaves optional, or declares with a wider type, so the result's type
// is not the target's.
interface Parcel {
  street: string;
  floors?: number;
  owner?: string;
}

const parcel: Parcel = { street: "elm" };
const filled = Object.assign(parcel, { owner: "ada", floors: 2 });
console.log(filled === parcel, filled.street, filled.floors + 1, filled.owner.length);
filled.street = "oak";
console.log(parcel.street, parcel.floors, parcel.owner);
parcel.floors = 5;
console.log(filled.floors, filled.owner, parcel.owner);

// A member the target declares wider than the source supplies it.
interface Reading {
  station: string;
  level: string | number;
  note: string | null;
}
const reading: Reading = { station: "north", level: "low", note: null };
const supplied: { level: number; note: string } = { level: 7, note: "gauge" };
const measured = Object.assign(reading, supplied);
console.log(measured === reading, measured.level * 2, measured.note.toUpperCase());
measured.station = "south";
reading.level = 9;
console.log(reading.station, measured.level, measured.note, reading.note);

// The same inside a function, where the bindings are locals, and with the
// result used without a binding.
function survey(): string {
  const lot: Parcel = { street: "ash" };
  const done = Object.assign(lot, { floors: 1, owner: "bo" });
  done.street = "fir";
  lot.owner = "cy";
  return [done === lot, lot.street, done.owner, done.floors + 1, lot.floors].join(" ");
}
console.log(survey());
const other: Parcel = { street: "yew", owner: "di" };
console.log(Object.assign(other, { floors: 3 }) === other, Object.assign(other, { floors: 4 }).floors);
console.log(other.street, other.floors, other.owner);
