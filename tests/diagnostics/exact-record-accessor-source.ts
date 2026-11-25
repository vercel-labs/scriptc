// The own-key questions about a typed record are answered from its declared
// fields (corpus: exact-record-own-key-questions): every present field is an
// own data member. An object whose member is an accessor has no such field
// to copy into, so assigning it to the record type stays a refusal instead
// of a record that answers for a getter it does not have.
type Row = { id: number; author: string; text: string; note?: string };

function isExactRow(value: Row): boolean {
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const keys = Object.keys(value);
  let at = 0;
  if (keys[at] !== "id") {
    return false;
  }
  at++;
  if (keys[at] !== "author") {
    return false;
  }
  at++;
  if (keys[at] !== "text") {
    return false;
  }
  at++;
  if (keys[at] === "note") {
    at++;
  }
  return at === keys.length;
}

const source = {
  id: 1,
  author: "ada",
  get text(): string {
    return "first";
  },
};
const row: Row = source;
console.log(isExactRow(row));
