// Pins: an array pattern whose source is a conditional with an empty array
// literal in one arm, `const [a, b] = listed ? rows[key] : []`. Only the
// literal stands for "no elements". When the condition picks the tuple arm
// and that arm holds nothing (a lookup that found no row, a value asserted
// present), Node has nothing to iterate and throws a TypeError, and the
// compiled program throws the same error. Behind `??` the same missing value
// selects the literal, and every binding reads undefined.
const tides: Record<string, [height: number, phase: string]> = {
  dover: [6.7, "flood"],
  leith: [5.2, "ebb"],
};

function outcome(run: () => string): string {
  try {
    return run();
  } catch (error) {
    return `${error instanceof TypeError ? "TypeError" : "other error"}: ${(error as Error).message}`;
  }
}

// The literal in the second arm: a port with a row, the literal picked, and a
// port with no row under both answers of the condition.
function reading(port: string, listed: boolean): string {
  const [height, phase] = listed ? tides[port] : [];
  return `${port}: ${String(height)} ${String(phase)}`;
}
console.log(outcome(() => reading("dover", true)));
console.log(outcome(() => reading("dover", false)));
console.log(outcome(() => reading("oban", false)));
console.log(outcome(() => reading("oban", true)));

// The literal in the first arm.
function skipped(port: string, skip: boolean): string {
  const [height, phase] = skip ? [] : tides[port];
  return `${port}: ${String(height)} ${String(phase)}`;
}
console.log(outcome(() => skipped("leith", false)));
console.log(outcome(() => skipped("leith", true)));
console.log(outcome(() => skipped("wick", true)));
console.log(outcome(() => skipped("wick", false)));

// The control: `??` and `||` take a missing row as the literal.
function fallback(port: string): string {
  const [height, phase] = tides[port] ?? [];
  const [again] = tides[port] || [];
  return `${port}: ${String(height)} ${String(phase)} ${String(again)}`;
}
console.log(fallback("dover"), "|", fallback("oban"));

// A value asserted present asserts nothing at run time: undefined and null
// in the picked arm throw as the missing row does.
function gauge(mark: [depth: number, unit: string] | undefined, wet: boolean): string {
  const [depth, unit] = wet ? mark! : [];
  return `${String(depth)}${String(unit)}`;
}
function sounding(mark: [depth: number, unit: string] | null, dry: boolean): string {
  const [depth, unit] = dry ? [] : mark!;
  return `${String(depth)}${String(unit)}`;
}
console.log(outcome(() => gauge([3, "m"], true)), outcome(() => gauge(undefined, false)));
console.log(outcome(() => gauge(undefined, true)));
console.log(outcome(() => sounding([9, "ft"], false)), outcome(() => sounding(null, true)));
console.log(outcome(() => sounding(null, false)));

const moorings = new Map<string, [berth: string, length: number]>([["north", ["N4", 12]]]);
function berth(quay: string, open: boolean): string {
  const [name, length] = open ? moorings.get(quay)! : [];
  return `${String(name)} ${String(length)}`;
}
console.log(outcome(() => berth("north", true)), "|", outcome(() => berth("south", false)));
console.log(outcome(() => berth("south", true)));

// Defaults apply where the literal was picked and do not rescue a missing row.
function withDefaults(port: string, listed: boolean): string {
  const [height = -1, phase = "slack"] = listed ? tides[port] : [];
  return `${height} ${phase}`;
}
console.log(outcome(() => withDefaults("leith", true)), "|", outcome(() => withDefaults("leith", false)));
console.log(outcome(() => withDefaults("oban", true)));

// A hole and a single binding take the same check.
function phaseOnly(port: string, listed: boolean): string {
  const [, phase] = listed ? tides[port] : [];
  return String(phase);
}
function heightOnly(port: string, listed: boolean): string {
  const [height] = listed ? tides[port] : [];
  return String(height);
}
console.log(outcome(() => phaseOnly("dover", true)), outcome(() => phaseOnly("oban", true)));
console.log(outcome(() => heightOnly("dover", true)), outcome(() => heightOnly("oban", true)));

// The condition is evaluated once, and the tuple arm only when it is picked.
let asked = 0;
let looked = 0;
function listedNow(answer: boolean): boolean {
  asked++;
  return answer;
}
function row(port: string): [height: number, phase: string] {
  looked++;
  return tides[port];
}
const [first, second] = listedNow(true) ? row("dover") : [];
const [third] = listedNow(false) ? row("leith") : [];
console.log(first, second, third, asked, looked);
console.log(
  outcome(() => {
    const [height] = listedNow(true) ? row("oban") : [];
    return String(height);
  }),
  asked,
  looked,
);
