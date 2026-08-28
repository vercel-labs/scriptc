// split(regex) — capture-free patterns (captures are fenced).
function show(parts: string[]): string {
  return parts.length + ":[" + parts.join("|") + "]";
}

console.log(show("a1b2c".split(/\d/)));
console.log(show("one, two,three ,  four".split(/\s*,\s*/)));

// Empty pattern separates every UTF-16 unit; empty subjects.
console.log(show("abc".split(/(?:)/)));
console.log(show("".split(/(?:)/)));
console.log(show("".split(/x/)));

// No match: one piece, the whole string.
console.log(show("abc".split(/z/)));

// Leading/trailing/adjacent separators produce empty pieces.
console.log(show(",a,,b,".split(/,/)));

// A match that can be empty: zero-length matches advance, and a match
// ending at the end of the string leaves a trailing empty piece.
console.log(show("ab".split(/b*/)));
console.log(show("aXbXXc".split(/X*/)));

// Sticky separators probe positions like the spec's matcher.
console.log(show("abab".split(/b/y)));

// The g flag is irrelevant to split (the spec builds its own matcher).
console.log(show("a1b2c".split(/\d/g)));

// split on a longer text, then feed pieces back through replace.
const csv = "name;age;city";
const cols = csv.split(/;/);
console.log(show(cols), cols[1].replace(/a/, "A"));

// The optional limit shares split's ToUint32 rules with string separators.
console.log(show("a1b2c3".split(/\d/, 0)));
console.log(show("a1b2c3".split(/\d/, 1)), show("a1b2c3".split(/\d/, 3)));
console.log(show("abc".split(/(?:)/, 2)));
console.log(show("a1b2c3".split(/\d/, 4294967298)));
console.log(show("a1b2c3".split(/\d/, -1)));

function optionalLimit(limit?: number): string {
  return show("a1b2c3".split(/\d/, limit));
}
console.log(show("a1b2c3".split(/\d/, undefined)));
console.log(optionalLimit(), optionalLimit(undefined), optionalLimit(2));
