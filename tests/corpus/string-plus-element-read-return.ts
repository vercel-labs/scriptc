// A function declared to return a string concatenates a string with an
// element of a readonly string array. A missing element reads as undefined,
// which `+` turns into "undefined" next to a string, so the result is always
// a string and its call can be used inline.

const PAD: readonly string[] = ["00", "01", "02"];

function label(i: number): string {
  return "x-" + PAD[i];
}
function date(y: number, m: number, d: number): string {
  return y + "-" + PAD[m] + "-" + PAD[d];
}
function suffix(i: number): string {
  return PAD[i] + "!";
}

console.log(label(1).length, label(1), label(7));
console.log(date(2026, 1, 2).length, date(2026, 2, 9));
console.log(suffix(0).toUpperCase(), suffix(5));

// Two possibly missing reads add to NaN when both are missing.
function pair(i: number, j: number): string {
  return PAD[i] + PAD[j];
}
const both = pair(8, 9);
console.log(pair(0, 1), typeof both, String(both));

// A missing element held in a binding or returned by a function is undefined,
// so two of them still add to NaN.
function at(i: number): string {
  return PAD[i];
}
function viaBinding(i: number, j: number): string {
  const head = PAD[i];
  return head + PAD[j];
}
function viaCall(i: number, j: number): string {
  return at(i) + PAD[j];
}
console.log(viaBinding(0, 1), String(viaBinding(5, 6)), typeof viaBinding(5, 6));
console.log(viaCall(0, 2), String(viaCall(5, 6)), viaBinding(0, 9));
