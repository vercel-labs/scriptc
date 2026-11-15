// A tuple slot holds a record whose unknown index signature runs a getter:
// the getter replaces the tuple slot that holds the record while
// JSON.stringify walks it. The walk holds the record it started from, so the
// replaced value is released only after the member is written, and the
// answer matches Node instead of reading a freed record or its overflow map.
interface Row {
  id: number;
  [key: string]: unknown;
}

let holder: [Row, number];
const row: Row = { id: 1 };
row["trap"] = {
  get value() {
    holder[0] = { id: 9 };
    return 7;
  },
};
holder = [row, 2];
console.log(JSON.stringify(holder));

// The same getter reached through an array element.
const list: Row[] = [row, { id: 3 }];
console.log(JSON.stringify(list));
