// The binding of a generic instance where the checker narrowed nothing: its
// type at the read is the type the body was checked with (the constraint),
// and the instance holds a union of several layouts under it. Plain data.
interface Part {
  readonly id: string;
  readonly grams: number;
  readonly spare?: string;
}

const bolt = { id: "bolt", grams: 12, spare: "nut" } as const;
const plate = { id: "plate", grams: 340 } as const;
const stock: Part[] = [{ id: "rod", grams: 75 }, { id: "gear", grams: 110, spare: "pin" }];

// A member every layout stores, and one only some store.
function labels<T extends ReadonlyArray<Part>>(parts: T): string[] {
  const out: string[] = [];
  for (const part of parts) out.push(part.id + (part.spare ? "+" + part.spare : ""));
  return out;
}

// Arithmetic over a member, and a second read after a test of the first.
function heavy<T extends ReadonlyArray<Part>>(parts: T, limit: number): number {
  let total = 0;
  for (const part of parts) {
    if (part.grams > limit) total += part.grams;
  }
  return total;
}

// A binding declared with the element type of the list.
function last<T extends ReadonlyArray<Part>>(parts: T): T[number] {
  let found: T[number] = parts[0]!;
  for (const part of parts) found = part;
  return found;
}

// A narrowing the checker did prove keeps working beside the view.
function spares<T extends ReadonlyArray<Part | null>>(parts: T): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part === null) out.push("gap");
    else out.push(part.spare ?? part.id);
  }
  return out.join(",");
}

console.log(labels([bolt, plate, ...stock]).join(","));
console.log(labels([bolt, plate]).join(","), labels(stock).join(","), labels([plate]).length);
console.log(heavy([bolt, plate, ...stock], 50), heavy([...stock, plate], 100), heavy([bolt], 50));
console.log(last([bolt, plate, ...stock]).id, last([...stock, bolt]).id, last([plate, bolt]).grams);
console.log(spares([bolt, null, plate, ...stock]), spares([null, ...stock, bolt]), spares(stock));
