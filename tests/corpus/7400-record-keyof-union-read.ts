// Keyed reads of records whose fields have different types, with a key
// typed as `keyof` the record: the read is the union of the field types.
interface Book {
  readonly id: string;
  readonly title: string;
  readonly year: number;
  readonly tags: readonly string[];
  readonly available: boolean;
}
type BookPatch = Partial<Omit<Book, "id">>;

function changedKeys(current: Book, patch: BookPatch): string[] {
  const changed: string[] = [];
  for (const key of Object.keys(patch) as (keyof BookPatch)[]) {
    const before = current[key];
    const after = patch[key];
    if (after === undefined) continue;
    if (Array.isArray(before) && Array.isArray(after)) {
      if (before.join("|") !== after.join("|")) changed.push(key);
    } else if (before !== after) changed.push(key);
  }
  return changed;
}

function describe(book: Book, key: keyof Book): string {
  const value = book[key];
  if (typeof value === "string") return `${key}: string ${value}`;
  if (typeof value === "number") return `${key}: number ${value.toFixed(1)}`;
  if (typeof value === "boolean") return `${key}: boolean ${value ? "yes" : "no"}`;
  return `${key}: list of ${value.length} [${value.join(", ")}]`;
}

const book: Book = { id: "b1", title: "Atlas", year: 1999, tags: ["maps", "travel"], available: true };
console.log(changedKeys(book, { title: "Atlas", year: 2001 }));
console.log(changedKeys(book, { tags: ["maps", "travel"], available: false }));
console.log(changedKeys(book, { tags: ["maps"], title: "Atlas II", year: undefined }));
for (const key of ["id", "title", "year", "tags", "available"] as const) console.log(describe(book, key));
const keys: (keyof Book)[] = ["year", "tags"];
const values = keys.map((k) => book[k]);
console.log(values, values.length);
console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, book[k]]))));
