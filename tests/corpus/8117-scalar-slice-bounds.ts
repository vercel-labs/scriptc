// slice() and substring() results read only for their length and code
// units, so no string is built: ASCII, non-ASCII, astral and empty
// receivers, with integer, negative, fractional, -0, NaN, infinite and huge
// bounds, one bound or two, and substring's swapped bounds.
const receivers = ["", "a", "hello world", "héllo", "a😀b", "日本語テキスト"];
const bounds = [0, 1, 2, -1, -2, -0, 0.5, -0.5, 3.7, -3.7, NaN, Infinity, -Infinity, 1e20, -1e20];

function sliceFacts(text: string, start: number, end: number): string {
  const both = text.slice(start, end);
  const from = text.slice(start);
  const sub = text.substring(start, end);
  const subFrom = text.substring(start);
  return [both.length, both.charCodeAt(0), from.length, from.charCodeAt(from.length - 1), sub.length, sub.charCodeAt(0), subFrom.length].join(",");
}

let lines = 0;
for (const text of receivers) {
  const facts: string[] = [];
  for (const start of bounds) {
    for (const end of bounds) facts.push(sliceFacts(text, start, end));
  }
  console.log(JSON.stringify(text), facts.length, facts.join(" "));
  lines++;
}
console.log("receivers", lines);
