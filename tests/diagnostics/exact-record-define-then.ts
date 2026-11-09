// The own-key questions about a typed record are answered from its declared
// fields (corpus: exact-record-own-key-questions). That answer holds because
// a typed record cannot be given an own member its type does not declare
// without the program saying so where the compiler sees it. A non-enumerable
// 'then' would be listed by Reflect.ownKeys and by no declared field, so the
// call that defines one on a typed record stays a refusal.
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
Object.defineProperty(row, "then", { value: 1, enumerable: false });
console.log(isExactRow(row));
