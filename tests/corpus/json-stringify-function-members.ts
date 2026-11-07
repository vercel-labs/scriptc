// JSON.stringify omits a property whose value is a function, as it omits
// undefined: required and optional callback fields, a field that holds a
// string or a function, and the same shapes nested and indented.
interface Options {
  name: string;
  onDone: () => void;
  onError?: (message: string) => void;
  retries: number;
}

interface Row {
  id: number;
  label: string | (() => string);
  note?: string | ((id: number) => string);
  last: boolean;
}

interface Leaf {
  value: number;
  refresh: () => void;
}

interface Tree {
  leaf: Leaf;
  children: Tree[];
  extra?: { format: (() => string) | null; steps: Array<(() => void) | string> };
}

function show(value: Options | Row | Tree): string {
  return JSON.stringify(value);
}

function options(name: string, withError: boolean): Options {
  const made: Options = { name, onDone: () => {}, retries: name.length };
  if (withError) made.onError = (message) => console.log(message);
  return made;
}

console.log(show(options("plain", false)));
console.log(show(options("handled", true)));
console.log(JSON.stringify([options("a", true), options("bb", false)]));

const rows: Row[] = [
  { id: 1, label: "text", last: false },
  { id: 2, label: () => "computed", last: false },
  { id: 3, label: "both", note: "kept", last: false },
  { id: 4, label: () => "none", note: (id) => `#${id}`, last: true },
];
for (const row of rows) console.log(show(row));
console.log(JSON.stringify(rows));
console.log(JSON.stringify({ only: () => 1 }), JSON.stringify({ first: () => 1, second: 2 }));

const leaf: Leaf = { value: 1, refresh: () => {} };
const tree: Tree = {
  leaf,
  children: [
    { leaf, children: [], extra: { format: null, steps: [() => {}, "wait", () => {}] } },
    { leaf: { value: 2, refresh: () => {} }, children: [] },
  ],
  extra: { format: () => "f", steps: [] },
};
console.log(show(tree));
console.log(JSON.stringify(tree, null, 2));
console.log(JSON.stringify(rows, null, "\t"));

// The property is omitted, not its key order: later assignments still land
// where the object first received the key.
const late: Row = { id: 5, label: () => "x", last: true };
late.label = "now text";
console.log(show(late));
late.label = () => "again";
console.log(show(late), typeof late.label);
