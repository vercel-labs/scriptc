// String.fromCharCode with several arguments: ASCII and non-ASCII units,
// surrogate pairs that combine, lone and reversed surrogates, ToUint16 of
// large, negative, fractional and NaN codes, zero to seventeen arguments,
// and the spread form.
const show = (s: string): string =>
  `${JSON.stringify(s)}:${s.length}:${Array.from(s, (c) => c.codePointAt(0)!.toString(16)).join(".")}`;
console.log(show(String.fromCharCode()));
console.log(show(String.fromCharCode(104, 105)));
console.log(show(String.fromCharCode(0xe9, 0x65e5, 0x41)));
console.log(show(String.fromCharCode(0xd83d, 0xde00)));
console.log(show(String.fromCharCode(0xde00, 0xd83d)));
console.log(show(String.fromCharCode(0xd800, 0x41, 0xdc00)));
console.log(show(String.fromCharCode(0x10041, -1, 65.9, NaN, 2 ** 32 + 66)));
console.log(
  show(String.fromCharCode(97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112)),
);
console.log(
  show(String.fromCharCode(97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113)),
);
const codes = [0x48, 0xd83d, 0xde00, 0x21];
console.log(show(String.fromCharCode(...codes)));
let out = "";
for (let i = 0; i < 26; i++) out += String.fromCharCode(97 + i, 65 + i);
console.log(out, out.length);
let calls = 0;
const next = (): number => 65 + calls++;
console.log(String.fromCharCode(next(), next(), next()), calls);
