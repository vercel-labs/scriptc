// @transform-types
// Enum member lookup through a runtime string key (`E[name as keyof
// typeof E]`): each member name answers its constant — string, numeric and
// renamed members alike — and a name no member carries reads undefined.
enum Color {
  red = "red",
  "dark-blue" = "dark-blue",
  green = "light-green",
}

enum Level {
  low,
  mid = 5,
  high,
}

function color(name: string | undefined): Color | undefined {
  return name ? Color[name as keyof typeof Color] : undefined;
}

for (const name of ["red", "dark-blue", "green", "light-green", "", undefined]) {
  console.log(JSON.stringify(name), JSON.stringify(color(name)));
}

const levelName = process.argv.length > 99 ? "unused" : "high";
const level: Level | undefined = Level[levelName as keyof typeof Level];
console.log(level, level === Level.high);
const missing: Level | undefined = Level[("med" + "ium") as keyof typeof Level];
console.log(missing === undefined);
