// The own-key questions about a typed record are answered from its declared
// fields (corpus: exact-record-own-key-questions): every present field is an
// own enumerable member. A declared member made non-enumerable would leave
// Object.keys one name short of Reflect.ownKeys, which no field records, so
// the call that redefines a declared member of a typed record stays a
// refusal.
type Row = { id: number; author: string; text: string; note?: string };

function isExactRow(value: Row): boolean {
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
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
  return at === keys.length && Object.keys(value).length === at;
}

const row: Row = { id: 1, author: "ada", text: "first" };
Object.defineProperty(row, "text", { value: "first", enumerable: false });
console.log(isExactRow(row));
