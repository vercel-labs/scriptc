// A union arm that fits several arms of the destination union enters the arm
// its own discriminant names, and the conversion copies it into that arm's
// layout. Under Node the value stays one object. Here the caller's list still
// holds the value and the program writes through the converted one, so the
// write would not reach the other name: the conversion has no layout mapping
// that keeps the object.

type Crate = { weight: number };
type Stored = { place: "stored"; shelf?: number };
type Shipped = { place: "shipped"; carrier: string; days: number };
type Parcel = Stored | Shipped;
type Tracked = Parcel & { scanned?: boolean };

function scan(item: Crate | Parcel): string {
  if (!("place" in item)) return "crate";
  const tracked: Tracked = item;
  tracked.scanned = true;
  return JSON.stringify(item);
}

const dock: (Crate | Parcel)[] = [{ weight: 4 }, { place: "shipped", carrier: "rail", days: 2 }];
for (const item of dock) console.log(scan(item));
