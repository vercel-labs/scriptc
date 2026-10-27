// Object patterns over regex match results: numeric keys read the match
// positions (an unmatched optional group is undefined, a position past the
// end takes its default), `index` and `input` are the result's own
// properties, and `groups` is the named-group object when the regex is known.
const re = /(\d+)-(\d+)?/;
function first(text: string): string {
  const m = re.exec(text);
  if (!m) return "none";
  const { 0: whole, 1: a, 2: b, index, input } = m;
  return `${whole}|${a}|${b}|${index}|${input}`;
}
console.log(first("x 12-34 y"), first("ab 7- c"), first("none"));

const matched = "key=value".match(/(?<k>\w+)=(?<v>\w+)/);
if (matched) {
  const { index, input, groups } = matched;
  console.log(index, input, groups?.k, groups?.v);
  const { 1: key, groups: named } = matched;
  console.log(key, named?.v);
}

const exec = /b/.exec("abc")!;
const { index: at, input: text, 0: hit, 3: missing = "default" } = exec;
console.log(at, text, hit, missing);

function viaParam({ index, 0: s }: RegExpExecArray): string {
  return `${index}:${s}`;
}
console.log(viaParam(/c/.exec("abc")!));

let total = 0;
for (const word of ["aa1", "b22", "333"]) {
  const r = /\d+/.exec(word);
  if (r) {
    const { index, 0: digits } = r;
    total += index + digits.length;
  }
}
console.log(total);

// path-to-regexp's regexpToFunction shape.
function matcher(pattern: RegExp): (pathname: string) => false | { path: string; index: number } {
  return function (pathname: string) {
    const m = pattern.exec(pathname);
    if (!m) return false;
    const { 0: path, index } = m;
    return { path, index };
  };
}
const match = matcher(/\/users\/(\d+)/);
console.log(match("/api/users/42"), match("/other"));
