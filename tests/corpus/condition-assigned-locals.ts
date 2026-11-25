// A value saved inside a condition and read again by the branches, the loop
// body, the code after the statement and a closure made in a branch: the
// value lives until the block around the statement ends, on every way out.
interface Book {
  title: string;
  pages: number;
}
class Shelf {
  name: string;
  slots: number;
  constructor(name: string, slots: number) {
    this.name = name;
    this.slots = slots;
  }
  describe(): string {
    return this.name + "#" + String(this.slots);
  }
}
function title(i: number): string {
  return "volume-" + String(i * 11);
}
function book(i: number): Book {
  return { title: "book-" + String(i), pages: 40 + i * 15 };
}
function shelf(i: number): Shelf {
  return new Shelf("shelf-" + String(i), i + 2);
}
function stamp(i: number): (n: number) => string {
  const prefix = "stamp-" + String(i);
  return (n) => prefix + "/" + String(n * i);
}
function marks(i: number): number[] {
  return [i, i + 1, i * i];
}
function parsed(i: number): unknown {
  return JSON.parse('{"row":' + String(i) + ',"notes":["x","y"]}');
}

const log: string[] = [];
const later: (() => string)[] = [];

function branches(i: number): string {
  let name: string;
  if (((name = title(i)), name.length % 2 === 0)) {
    log.push("even " + name);
  } else {
    log.push("odd " + name);
  }
  let entry: Book;
  if (i === 7) {
    log.push("seven");
  } else if (((entry = book(i)), entry.pages > 60)) {
    return "long " + entry.title + " after " + name;
  } else {
    log.push("short " + entry.title);
  }
  let place: Shelf;
  if (i !== 2 && ((place = shelf(i)), place.slots % 2 === 0)) {
    later.push(() => "kept " + place.describe());
    throw new Error("full " + place.describe());
  }
  let raw: unknown;
  if (i === 5 || ((raw = parsed(i)), JSON.stringify(raw).length > 100)) {
    log.push("skipped");
  } else {
    log.push("raw " + JSON.stringify(raw));
  }
  return "done " + name;
}

function loops(i: number): string {
  let seen = "";
  for (let round = 0; round < 3; round++) {
    let ink: (n: number) => string;
    let n = 0;
    while (((ink = stamp(i + n)), n++ < 3 && ink(1).length < 12)) {
      if (n === 2) continue;
      seen += ink(n) + " ";
      if (round === 2) break;
    }
    seen += "| " + ink(round) + " ";
    let row: number[];
    for (let k = 0; ((row = marks(i + k)), k < 2 && row[2]! < 30); k++) {
      later.push(() => "row " + row.join("."));
      if (round === 1) break;
      seen += row.join(",") + " ";
    }
    seen += "/ " + String(row.length) + " ";
    let last: Book;
    let turns = 0;
    do {
      turns++;
    } while (((last = book(i + turns)), turns < 2 && last.pages < 100));
    seen += last.title + " ";
    if (round === 0) continue;
    seen += "; ";
  }
  return seen;
}

function choices(i: number): string {
  let pick: Shelf;
  let text = "";
  switch (((pick = shelf(i)), pick.slots % 3)) {
    case 0:
      text += "zero " + pick.describe();
      break;
    case 1:
      later.push(() => "picked " + pick.describe());
      text += "one " + pick.describe();
      break;
    default:
      text += "rest " + pick.name;
  }
  let word: string;
  const chosen = ((word = title(i)), word.length > 8) ? "wide " + word : "narrow " + word;
  let other: Book;
  const both = i % 2 === 0 && ((other = book(i)), other.pages > 50) ? "thick " + other.title : "thin";
  let spare: number[];
  const fallback = (i % 3 === 0 ? null : "set") ?? ((spare = marks(i)), spare.join("+"));
  return text + " " + chosen + " " + both + " " + fallback + " " + pick.describe() + " " + word;
}

for (let i = 0; i < 6; i++) {
  try {
    log.push(branches(i));
  } catch (e) {
    log.push("caught " + (e as Error).message);
  }
  log.push(loops(i));
  log.push(choices(i));
}
for (const f of later) log.push(f());
console.log(log.join("\n"));
