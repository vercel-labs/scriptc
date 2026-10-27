// Field parsing on ASCII text: Number() on digit strings (signs, zeros,
// 15 and 16 digits, whitespace and other grammar), indexOf from the start
// and from other positions, slice bounds, and split results of every
// size, including more pieces than one batch and results that grow.
const numbers = [
  "0", "-0", "+0", "7", "-7", "+42", "007", "-007", "123456789012345", "-123456789012345",
  "1234567890123456", "9007199254740993", "-", "+", "", " 12", "12 ", "\t3\n", "1e3",
  "1.5", "0x1f", "-0x1f", "12px", "1_000", "Infinity", "-Infinity", "+-1", "--1",
];
for (const text of numbers) {
  const value = Number(text);
  console.log(JSON.stringify(text), value, Object.is(value, -0));
}

const line = "/route/17?request=123 200 45 3200";
console.log(line.indexOf("?"), line.indexOf(" "), line.indexOf("x"), line.indexOf(""));
console.log(line.indexOf("?", -5), line.indexOf("?", NaN), line.indexOf("?", 10), line.indexOf(" ", 30));
console.log(line.indexOf("", 100), line.indexOf("", -1), "".indexOf(""), "".indexOf("a"));
console.log(line.indexOf("é"), "aé?".indexOf("?"), "aé?".indexOf("é"));
console.log(line.slice(0, line.indexOf("?")), line.slice(-4), line.slice(5, 2), line.slice(-100, 3));
console.log(line.slice(NaN, Infinity) === line, line.slice(2, -2), "héllo".slice(1, 3));

const fields = line.split(" ");
console.log(fields.length, fields.join("|"));
fields.push("extra");
fields[0] = fields[0]!.slice(0, 6);
console.log(fields.length, fields.join("|"));

const many = Array.from({ length: 150 }, (_, i) => String(i * 7)).join(",");
const pieces = many.split(",");
console.log(pieces.length, pieces[0], pieces[63], pieces[64], pieces[149]);
let sum = 0;
for (const piece of pieces) sum += Number(piece);
console.log(sum);
console.log("a,b,,c,".split(","), ",".split(","), "".split(","), "abc".split(",", 0));
console.log("a b c d".split(" ", 2), "x--y--z".split("--"), "héllo wörld".split(" "));

const rows = "/a?x=1 200 5 10\n/b 404 7 20\n/a?y=2 500 9 30\n";
const totals = new Map<string, number>();
for (const row of rows.split("\n")) {
  const parts = row.split(" ");
  if (parts.length !== 4) continue;
  const raw = parts[0]!;
  const query = raw.indexOf("?");
  const route = query < 0 ? raw : raw.slice(0, query);
  totals.set(route, (totals.get(route) ?? 0) + Number(parts[1]) + Number(parts[3]));
}
console.log([...totals.entries()].map(([route, total]) => route + "=" + total).join(";"));
