// Inline replace callbacks whose parameters after the match are left
// untyped: captures every match sets, captures that can be unset (in an
// alternation, an optional or zero-repeat group, a lookahead), the offset,
// the subject and the groups object, reassigned parameters, named groups,
// patterns with classes, escapes and lookbehind, function expressions and
// replaceAll.
const lines = ["id7,tag12;tag3", "x9 y10", "", "naïve 😀 42", "a-b-c"];
for (const line of lines) {
  console.log(line.replace(/tag(\d+)/g, (_m, d) => String(Number(d) + 1)));
  console.log(line.replace(/(\w)(\d+)/g, (m, letter, digits, offset, subject) =>
    `[${letter}:${digits.length}@${offset}/${subject.length}]`));
  console.log(line.replace(/(a)|(\d)/g, (m, a, digit) => `<${typeof a},${typeof digit}>`));
  console.log(line.replace(/(x)?(\d)/g, (m, x, d) => `${x === undefined ? "-" : x}${d}`));
  console.log(line.replace(/(?:(t)a)*g/g, (m, t, offset) => `{${t}|${offset}}`));
  console.log(line.replace(/(?=(\d))\d/g, (m, ahead, offset) => `${ahead}${offset}`));
  console.log(line.replace(/(?<n>\d)(\d)?/g, (m, n, rest, offset, subject, groups) =>
    `${n}${rest ?? "_"}${offset}${typeof subject}${JSON.stringify(groups)}`));
  console.log(line.replace(/([\(\)\[\]]|[a-c])(-)/g, (m, c, dash) => c.toUpperCase() + dash.length));
  console.log(line.replace(/(?<=-)(\w)/g, (m, c, offset) => c + offset.toFixed(1)));
  console.log(line.replaceAll(/(\d)/g, function (m, d, offset) {
    return `${d * 2}:${offset + 1}`;
  }));
  console.log(line.replace(/(\d)/g, (m, d) => {
    d = d.length > 0 ? 5 : 6;
    return String(d + 1);
  }));
  console.log(line.replace(/(\d)\1?/g, (m, d, offset, subject) => `${d}${offset}${subject === line}`));
  console.log(line.replace(/(.)/u, (m, c, offset, subject, extra) => `${c.codePointAt(0)}${offset}${extra}`));
  console.log(line.replace(/(\d){0,2}x/g, (m, d) => `${d}`));
  console.log(line.replace(/(\w)(\w)/g, (m, a, b, offset) =>
    [a.toUpperCase(), b.toLowerCase(), a.trim(), a.charCodeAt(0), b.codePointAt(0), a.slice(0, 1),
      b.substring(0), a.repeat(2), b.padStart(3, "."), a.padEnd(2, "!"), b.includes("1"),
      a.startsWith("t"), b.endsWith("g"), a.indexOf("a"), a.length, parseInt(b, 36),
      parseFloat(b), Number(b), String(offset), offset - 1, offset * 2, offset % 3, offset < 4,
      a === b, a !== "x", a + offset, offset + 1, `${offset}`].join(",")));
  console.log(line.replace(/(\d+)/g, (m, d) => (d)));
  console.log(line.replace(/(\d+)/g, function (m, d) { return d + d; }));
}
let count = 0;
console.log("tag1 tag2".replace(/tag(\d)/g, (m, d) => {
  count += Number(d);
  return d.repeat(2);
}), count);
