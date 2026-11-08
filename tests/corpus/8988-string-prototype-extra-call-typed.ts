// The same Annex B CreateHTML and extra string methods through
// `Function.prototype.call` in a typed source: the call lowers to the typed
// method over the converted receiver, so a namespace-style call and the
// equivalent member call print the same text.

const s: string = "Ab";

console.log(String.prototype.big.call(s), s.big());
console.log(String.prototype.anchor.call(s, 'x"<y'));
console.log(String.prototype.fontcolor.call(s, "red"));
console.log(String.prototype.substr.call(s, 1, 1), s.substr(1, 1));
console.log(String.prototype.concat.call(s, "c", "d"), s.concat("c", "d"));
console.log(String.prototype.toLocaleLowerCase.call(s), String.prototype.toLocaleUpperCase.call("ab"));

function receiver(): string {
  return "R";
}
console.log(String.prototype.sub.call(receiver()));
