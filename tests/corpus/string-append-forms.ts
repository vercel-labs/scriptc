// Every way of building a text by appending, by where the text is held (a local, a module
// variable, a class field from inside and from outside, a record field, an array element, a
// captured variable) x ASCII and non-ASCII pieces x lengths that cross the growth boundaries of
// the in-place append. Each form must print what Node prints: the UTF-16 length after every
// step is compared in the program and a checksum over every code unit is printed. Then the
// facts an in-place append must not break: an alias keeps the old text, the right side
// converts before the field is written, a throwing conversion leaves the field alone, and the
// proven-ASCII mark of a built string (JSON.stringify, a character append, encodeURIComponent)
// never answers a wrong length or index for a text with non-ASCII characters.
class Row {
  text: string;
  count: number;
  constructor() {
    this.text = "";
    this.count = 0;
  }
  put(s: string): void {
    this.text += s;
  }
  putLong(s: string): void {
    this.text = this.text + s;
  }
  putNumber(n: number): void {
    this.text += n;
  }
  putMaybe(s: string | undefined): void {
    this.text += s;
  }
}

class Holder {
  row: Row;
  constructor() {
    this.row = new Row();
  }
}

let moduleText: string = "";

function putModule(s: string): void {
  moduleText += s;
}
function putMember(row: Row, s: string): void {
  row.text += s;
}
function putNested(holder: Holder, s: string): void {
  holder.row.text += s;
}
function putRecord(rec: { text: string; n: number }, s: string): void {
  rec.text += s;
}
function putElement(parts: string[], i: number, s: string): void {
  parts[i] += s;
}

function checksum(text: string): number {
  let h = 7;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) % 1000003;
  }
  return h;
}

const asciiPieces: string[] = ["a", "bc", "defghij", "0123456789abcdefghij", "x".repeat(200), ""];
const mixedPieces: string[] = ["é", "a€b", "😀", "plain ascii piece 20", "ü".repeat(100) + "z", "", "\ud83d", "\ude00!"];
const forms: string[] = ["local", "module", "this", "thisLong", "member", "nested", "record", "element", "closure"];

function build(form: string, pieces: string[], appends: number): string {
  let expected = 0;
  let bad = 0;
  let text = "";
  const row = new Row();
  const holder = new Holder();
  const rec = { text: "", n: 1 };
  const parts: string[] = ["left", "", "right"];
  let captured = "";
  const putCaptured = (s: string): void => {
    captured += s;
  };
  moduleText = "";
  for (let i = 0; i < appends; i++) {
    const piece = pieces[(i * 7 + (i >> 3)) % pieces.length];
    expected += piece.length;
    let now = 0;
    if (form === "local") {
      text += piece;
      now = text.length;
    } else if (form === "module") {
      putModule(piece);
      now = moduleText.length;
    } else if (form === "this") {
      row.put(piece);
      now = row.text.length;
    } else if (form === "thisLong") {
      row.putLong(piece);
      now = row.text.length;
    } else if (form === "member") {
      putMember(row, piece);
      now = row.text.length;
    } else if (form === "nested") {
      putNested(holder, piece);
      now = holder.row.text.length;
    } else if (form === "record") {
      putRecord(rec, piece);
      now = rec.text.length;
    } else if (form === "element") {
      putElement(parts, 1, piece);
      now = parts[1].length;
    } else {
      putCaptured(piece);
      now = captured.length;
    }
    // A lone high surrogate followed by a lone low one joins into one character of two
    // units, so the length is the sum of the pieces' lengths in every case.
    if (now !== expected) bad++;
  }
  const result =
    form === "local" ? text
    : form === "module" ? moduleText
    : form === "this" || form === "thisLong" || form === "member" ? row.text
    : form === "nested" ? holder.row.text
    : form === "record" ? rec.text
    : form === "element" ? parts[1]
    : captured;
  moduleText = "";
  if (parts[0] !== "left" || parts[2] !== "right") bad++;
  return form + " " + result.length + " " + checksum(result) + " bad=" + bad;
}

for (const form of forms) {
  console.log("ascii " + build(form, asciiPieces, 700));
  console.log("mixed " + build(form, mixedPieces, 700));
}
// One long text of short pieces. 10,000 characters show a quadratic append as well as a longer
// text does; one form goes on to 200,000 characters and crosses every capacity step up to there.
for (const form of forms) {
  console.log("long " + build(form, ["0123456789abcdefghij", "k"], form === "member" ? 19000 : 1000));
}

// An alias keeps the text it saw.
{
  const row = new Row();
  for (let i = 0; i < 40; i++) row.put("piece " + i + ",");
  const before = row.text;
  row.put("AFTER");
  putMember(row, "é");
  const middle = row.text;
  row.putLong("tail");
  console.log(before.length, checksum(before), middle.length, checksum(middle), row.text.length, checksum(row.text));
  const parts: string[] = ["", "seed"];
  const kept = parts[1];
  putElement(parts, 1, "+more");
  console.log(kept, parts[1]);
  const rec = { text: "rec", n: 0 };
  const keptRec = rec.text;
  putRecord(rec, "+more");
  console.log(keptRec, rec.text);
  let local = "local";
  const keptLocal = local;
  local += "+more";
  console.log(keptLocal, local);
  // The same string held twice: appending through one holder leaves the other alone.
  const a = new Row();
  const b = new Row();
  a.put("shared text that is long enough to own a block of its own");
  b.text = a.text;
  a.put("|a");
  b.put("|b");
  console.log(a.text.slice(-12), b.text.slice(-12), a.text.length, b.text.length);
  // A text appended to itself.
  a.put(a.text);
  a.text += a.text;
  console.log(a.text.length, checksum(a.text));
}

// The right side converts before the field is written: a conversion that reads or writes the
// field sees the old text, and the append's result replaces what it wrote.
class Chatty {
  target: Row;
  seen: string;
  constructor(target: Row) {
    this.target = target;
    this.seen = "";
  }
  toString(): string {
    this.seen = this.target.text;
    this.target.text = "REPLACED";
    return "<chatty>";
  }
}
class Thrower {
  toString(): string {
    throw new Error("no text");
  }
}
{
  const row = new Row();
  row.put("start");
  const chatty = new Chatty(row);
  row.text += chatty;
  console.log(row.text, chatty.seen);
  const thrower = new Thrower();
  try {
    row.text += thrower;
  } catch (e) {
    console.log("caught", (e as Error).message, row.text);
  }
  row.putNumber(42);
  row.putNumber(-0.5);
  row.putMaybe(undefined);
  row.putMaybe("defined");
  row.text += true;
  console.log(row.text);
  const rec = { text: "r", n: 3 };
  rec.text += rec.n;
  rec.text += rec.text.length;
  console.log(rec.text);
}

// The value of an append expression, and appends in a chain.
{
  const row = new Row();
  const first = (row.text += "one");
  const second = (row.text += "," + first + ",") + "!";
  console.log(first, second, row.text);
  const other = new Row();
  other.text += row.text += "x";
  console.log(other.text, row.text);
}

// Built strings whose length and indices are asked for: the proven-ASCII mark must be absent
// from every result that holds a non-ASCII character.
{
  const names: string[] = ["plain", "café", "€5", "smile 😀", 'q"uote\n', "\ud83d", "tab\there", ""];
  for (const name of names) {
    const j = JSON.stringify(name);
    const o = JSON.stringify({ name, list: [name, 1.5, true, null], nested: { k: name } });
    const p = JSON.stringify({ name }, null, 2);
    const u = encodeURIComponent(name === "\ud83d" ? "x" : name);
    const v = encodeURI(name === "\ud83d" ? "y z" : name + " /?");
    let chars = "";
    for (let i = 0; i < name.length; i++) chars += name.charAt(i);
    let codes = "";
    for (let i = 0; i < name.length; i++) codes += String.fromCharCode(name.charCodeAt(i));
    let low = "";
    for (let i = 0; i < 20; i++) low += String.fromCharCode(97 + i);
    low += name;
    console.log(
      j.length, j.charCodeAt(j.length - 2), j.slice(1, 4).length, checksum(j),
      o.length, o.charCodeAt(9), checksum(o.slice(5, 30)),
      p.length, checksum(p),
      u.length, u.slice(-3), v.length, v.slice(-3),
      chars.length, chars === name, codes.length, codes === name,
      low.length, low.charCodeAt(low.length - 1), checksum(low),
    );
  }
  // A JSON text joined with other parts, and appended to.
  const out: string[] = [];
  for (const name of names) out.push(JSON.stringify(name), ":", JSON.stringify(name.length), ",");
  const joined = out.join("");
  let grown = JSON.stringify("ascii only");
  grown += JSON.stringify("café");
  grown += JSON.stringify(12.5);
  console.log(joined.length, checksum(joined), grown.length, grown.charCodeAt(16), checksum(grown));
}
