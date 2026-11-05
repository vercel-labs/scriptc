// A program module no island code imports, loaded into Node only through
// requireModule(): it is still the program's one instance.
export let tally = 0;

export function bumpTally() {
  tally++;
  return tally;
}
