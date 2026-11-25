// An optional function defaulted to a function whose result type is wider.
// The result of `own ?? fallback` (and of `own || fallback`) has the
// checker's type, the fallback's here, and each side enters it: the own
// function through an adapter that is that function to `===`, the fallback
// as it is. Neither is adapted into the other's type, so a fallback that
// answers a value outside the own function's result type is called as it
// is written.
type Tally = (votes: number) => number;
type Verdict = (votes: number) => number | string;
type Padded = (votes: number, pad: string) => number | string;

interface Ballot {
  tally?: Tally;
}

const calls: string[] = [];
const verdict: Verdict = (votes) => (votes > 50 ? votes : "recount");
const padded: Padded = (votes, pad) => pad + votes;
const twice: Tally = (votes) => votes * 2;
function lateVerdict(): Verdict {
  calls.push("fallback");
  return verdict;
}

function viaNullish(ballot: Ballot, votes: number): string {
  const run = ballot.tally ?? verdict;
  return String(run(votes)) + " " + (run === verdict) + "/" + (run === twice);
}
function viaOr(ballot: Ballot, votes: number): string {
  const run = ballot.tally || verdict;
  return String(run(votes)) + " " + (run === verdict) + "/" + (run === twice);
}
function viaLazy(ballot: Ballot, votes: number): string {
  const run = ballot.tally ?? lateVerdict();
  return String(run(votes));
}
function viaMoreParameters(ballot: Ballot, votes: number): string {
  const run = ballot.tally ?? padded;
  return String(run(votes, "#"));
}
function viaParameter(own: Tally | undefined, votes: number): string {
  return String((own ?? verdict)(votes));
}
function viaNull(own: Tally | null, votes: number): string {
  const run: Verdict = own ?? verdict;
  return String(run(votes));
}
function viaLookup(table: Map<string, Tally>, key: string, votes: number): string {
  const run = table.get(key) ?? verdict;
  return String(run(votes));
}
// An element read is typed present and can be absent: the default is then
// the answer, at its own type.
const counters: Tally[] = [twice];
function viaElement(at: number, votes: number): string {
  const run = counters[at] ?? verdict;
  return String(run(votes));
}

for (const ballot of [{ tally: twice }, {}] as Ballot[]) {
  console.log(viaNullish(ballot, 20), "|", viaNullish(ballot, 70));
  console.log(viaOr(ballot, 20), "|", viaOr(ballot, 70));
  console.log(viaLazy(ballot, 20), viaMoreParameters(ballot, 20));
}
console.log(viaParameter(twice, 20), viaParameter(undefined, 20), viaParameter(undefined, 70));
console.log(viaNull(twice, 20), viaNull(null, 20), viaNull(null, 70));
const table = new Map<string, Tally>([["twice", twice]]);
console.log(viaLookup(table, "twice", 20), viaLookup(table, "none", 20));
console.log(viaElement(0, 20), viaElement(3, 20), viaElement(3, 70));
console.log(calls.join(","));
