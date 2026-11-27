// An optional locale expression evaluates once: the undefined test and the
// conversion both read the held value, so a side effect runs one time.
let evaluations = 0;
let chosen: string | undefined = "de-DE";
function pick(): string | undefined {
  evaluations++;
  return chosen;
}
console.log("locale", new Intl.NumberFormat(pick()).format(1234.5), evaluations);
chosen = undefined;
console.log("fallback", new Intl.NumberFormat(pick()).format(1234.5), evaluations);
