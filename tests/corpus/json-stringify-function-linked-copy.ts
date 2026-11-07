// An object passed where a narrower record type is expected is still the
// one object: JSON.stringify writes every property it has, and omits the
// ones holding functions.
interface Wide {
  id: number;
  title: string;
  pick?: (input: any) => any;
  format?: (input: any) => any;
  steps: Array<(input: any) => any>;
}

interface Narrow {
  id: number;
}

interface Titled {
  title: string;
  id: number;
}

function narrow(wide: Wide): Narrow {
  return wide;
}

function titled(wide: Wide): Titled {
  return wide;
}

function copy(wide: Wide): Narrow {
  const made: Narrow = { ...wide };
  return made;
}

const full: Wide = { id: 1, title: "full", pick: (input) => input, steps: [(input) => input] };
const bare: Wide = { id: 2, title: "bare", steps: [] };

console.log(JSON.stringify(narrow(full)));
console.log(JSON.stringify(narrow(bare)));
console.log(JSON.stringify(titled(full)), JSON.stringify(copy(full)));
console.log(JSON.stringify([narrow(full), narrow(bare)], null, 1));
console.log(JSON.stringify({ item: narrow(full), fresh: { id: 3 } as Narrow }));

const { title, ...rest } = full;
console.log(title, JSON.stringify(rest));

// A fresh record of the narrow type has no other properties.
const fresh: Narrow = { id: 4 };
console.log(JSON.stringify(fresh), Object.keys(narrow(full)).join(","));
