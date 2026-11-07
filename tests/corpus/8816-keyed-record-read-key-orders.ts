// `TABLE[key]` with a runtime key, where `TABLE: Record<Level, T>` is keyed
// by a closed union of literals and the program's object literals write
// that record's keys in more than one order. Such a record remembers which
// order its literal used, in storage that is no property of the value: a
// keyed read or write names only the declared keys, whatever the key type
// (string literals, number literals, an enum, a wider string), and each
// record still enumerates in the order it was written.

type Level = "off" | "low" | "high";
const NOTES: Record<Level, string> = { off: "none", low: "light", high: "deep" };
const SHORT: Record<Level, string> = { high: "h", off: "o", low: "l" };
const BUDGET: Record<Level, number> = { off: 0, low: 1, high: 2 };
const SPENT: Record<Level, number> = { low: 10, high: 20, off: 30 };

type Step = 1 | 2 | 3;
const STEP_NAMES: Record<Step, string> = { 1: "one", 2: "two", 3: "three" };
const STEP_ALT: Record<Step, string> = { 3: "III", 1: "I", 2: "II" };

enum Tone {
  Warm = "warm",
  Cool = "cool",
}
const TONE_LABEL: Record<Tone, string> = { [Tone.Warm]: "W", [Tone.Cool]: "C" };
const TONE_ALT: Record<Tone, string> = { [Tone.Cool]: "c", [Tone.Warm]: "w" };

interface Item {
  value: string;
  label: string;
  note?: string;
}
function items(levels: Level[], current: Level, fallback?: Level): Item[] {
  return levels.map((level) => ({
    value: level,
    label: `${level === current ? "* " : "  "}${level}`,
    note: level === fallback ? `${NOTES[level]} (default)` : NOTES[level],
  }));
}
function short(level: Level): string {
  return SHORT[level];
}
function budget(level: Level): number {
  return BUDGET[level] + SPENT[level];
}
function step(n: Step): string {
  return STEP_NAMES[n] + STEP_ALT[n];
}
function tone(t: Tone): string {
  return TONE_LABEL[t] + TONE_ALT[t];
}
function wide(table: Record<Level, string>, key: string): string {
  const hit = (table as Record<string, string | undefined>)[key];
  return hit === undefined ? "missing" : hit;
}
function rename(table: Record<Level, string>, level: Level, text: string): void {
  table[level] = text;
}
function bump(table: Record<Level, number>, level: Level): void {
  table[level] += 1;
}

const levels: Level[] = ["off", "low", "high"];
console.log(JSON.stringify(items(["off", "high"], "high", "off")));
console.log(levels.map((level) => `${short(level)}/${budget(level)}`).join(" "));
console.log(([1, 2, 3] as Step[]).map(step).join(" "), [Tone.Warm, Tone.Cool].map(tone).join(" "));
console.log(wide(NOTES, "low"), wide(SHORT, "high"), wide(SHORT, "%order"), wide(NOTES, "nope"));
rename(SHORT, "low", "L");
rename(NOTES, "high", "DEEP");
bump(SPENT, "off");
bump(BUDGET, "high");
console.log(JSON.stringify(SHORT), JSON.stringify(NOTES), JSON.stringify(SPENT), JSON.stringify(BUDGET));
console.log(
  Object.keys(SHORT).join(),
  Object.keys(NOTES).join(),
  Object.keys(STEP_ALT).join(),
  Object.keys(TONE_ALT).join(),
);
for (const level of levels) console.log(level, level in SHORT, Object.hasOwn(NOTES, level));
