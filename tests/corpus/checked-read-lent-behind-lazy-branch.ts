// A checked element read is stabilized in a hidden local and lent to the
// field read that consumes it. That field read sits in a lazy branch — the
// else arm of `m[1] === undefined ? 0 : m[1].length` — so a pass that takes
// the other arm never stores the local. The local belongs to the sequence
// that produced it, not to the loop body: a body-scope release on the
// skipping pass releases the pointer an earlier pass stored, and a string the
// previous pass handed to the caller is freed while still referenced.
export {};

const rules: RegExp[] = [/^(a)/, /^b/];
function tokenize(source: string): number[] {
  const tokens: number[] = [];
  let rest = source;
  while (rest.length > 0) {
    let cut = 0;
    for (const rule of rules) {
      const m = rule.exec(rest);
      if (m === null) continue;
      cut = m[0].length;
      tokens.push(m[1] === undefined ? 0 : m[1].length);
      break;
    }
    if (cut === 0) break;
    rest = rest.slice(cut);
  }
  return tokens;
}

console.log(tokenize("ab".repeat(500)).length);
