// Functions that read the enum object after its declaration has run, from
// declarations placed before and after the enum, and a member read placed
// before the declaration (a constant either way).
function names(): string[] {
  return Object.keys(Level);
}
function first(): Level {
  return Level.Low;
}
console.log(first());
enum Level {
  Low,
  High,
}
const lookup = (value: number): string | undefined => Level[value];
console.log(names().join(","), lookup(1), lookup(7) === undefined);
class Reader {
  static all = Object.values(Level);
  read(): string {
    return JSON.stringify(Level);
  }
}
console.log(Reader.all.join(","), new Reader().read());
