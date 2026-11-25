// Pins: the returned assertion of 9391-built-record-declared-result.ts where
// the function's dictionary is a live object instead of a native key/value
// record. That is how a program holds its number-valued dictionaries when
// it hands an existing record to a dictionary parameter and writes through
// dictionaries of that value type, so that the two stay one object.
type Scores<Player extends string> = { [P in Player]: number } & {};

function scoreSheet<Player extends string>(
  players: readonly Player[],
  rounds: readonly (readonly [string, number])[],
): Scores<Player> {
  const sheet: Record<string, number> = {};
  for (const player of players) sheet[player] = 0;
  for (const [player, points] of rounds) {
    if (player in sheet) sheet[player] = sheet[player]! + points;
    else sheet[player] = points;
  }
  return sheet as Scores<Player>;
}

function viaUnknown<Player extends string>(players: readonly Player[]): Scores<Player> {
  const sheet: Record<string, number> = {};
  for (const player of players) sheet[player] = player.length;
  return sheet as unknown as Scores<Player>;
}

// A reader of any score dictionary.
function total(sheet: Record<string, number>): string {
  let sum = 0;
  for (const player of Object.keys(sheet)) sum += sheet[player]!;
  return `${Object.keys(sheet).join(",")}:${sum}`;
}
function leader(sheet: Record<string, number>): string {
  let best = "";
  for (const player of Object.keys(sheet)) if (best === "" || sheet[player]! > sheet[best]!) best = player;
  return best;
}

const evening = scoreSheet(["ada", "bo"] as const, [
  ["bo", 4],
  ["ada", 2],
  ["guest", 1],
  ["bo", 1],
]);
const morning = scoreSheet(["cy", "di", "eve"] as const, [["eve", 9]]);

console.log(evening.ada, evening.bo, morning.cy, morning.di, morning.eve);
console.log(Object.keys(evening).join(" "), "|", Object.keys(morning).join(" "));
console.log(JSON.stringify(evening), JSON.stringify(morning));

// The existing records flow into the dictionary parameter.
console.log(total(evening), total(morning));
console.log(leader(evening), leader(morning));

// Merged by a spread, then written through.
const day: Record<string, number> = { ...morning, ...evening };
day["late"] = 7;
console.log(total(day), leader(day));
console.log(Object.keys(evening).length, Object.keys(morning).length);

const lengths = viaUnknown(["zoe", "al"] as const);
console.log(total(lengths), lengths.zoe, lengths.al);
