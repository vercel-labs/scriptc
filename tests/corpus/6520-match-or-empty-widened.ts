// `s.match(re) ?? []` and `s.match(re) || []`: typescript-go types the
// empty literal by the tuple-like match result and cannot serialize the
// union's members (an upstream API panic); the widened union describes
// the same values, so the binding is an ordinary string array and the
// statement compiles instead of reporting the checker crash.
function scripts(text: string): string[] {
  const matches = text.match(/(['"]?)([\S^'"]+\.js)\1/g) ?? [];
  return matches.map((match) => match.replace(/^['"]|['"]$/g, "")).slice(0, 5);
}
console.log(scripts(`RUN node a.js 'b.js' "c.js"`), scripts("no scripts here"));

const words = "alpha beta".match(/\w+/g) || [];
console.log(words.length, words.join("+"));
const none = "".match(/x/) || [];
console.log(none.length);
