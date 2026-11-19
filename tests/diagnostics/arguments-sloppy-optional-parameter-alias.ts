// A script (no import or export) runs in sloppy mode, where `arguments`
// aliases a simple parameter list, optional parameters included: writing
// `value` changes `arguments[0]`. The hidden arguments array that counts a
// call's arguments is a copy, so it would print `1` where Node prints `5`.
function alias(value?: number): string {
  value = 5;
  return `${arguments.length}:${arguments[0]}`;
}
console.log(alias(1));
