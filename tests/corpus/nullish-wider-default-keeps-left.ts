// `left ?? right` where the default's type is wider than the left side's
// value. JavaScript answers the left side itself when it is present, so the
// result is that same object: identical to it, and a write through either
// name is seen through the other. The default runs only when the left side
// is missing, and the left side runs once.

const ran: string[] = [];

// A callback that takes fewer parameters than the default and answers a
// narrower result: the result is the callback itself.
type OnLoan = (title: string) => string;
type OnEvent = (title: string, days: number) => string | number;

const brief: OnLoan = (title) => `lent ${title}`;
const detailed: OnEvent = (title, days) => (days > 14 ? days : `${title} for ${days} days`);
function anyEvent(): OnEvent {
  ran.push("default");
  return detailed;
}

// An optional member of a record.
interface Desk {
  onLoan?: OnLoan;
}
function atDesk(desk: Desk): string {
  const notify = desk.onLoan ?? detailed;
  return `${notify("Emma", 7)} ${notify === brief} ${notify === detailed}`;
}
console.log(atDesk({ onLoan: brief }), "/", atDesk({}));

// A lookup, with a default that is a call: it runs for the missing key only.
const handlers = new Map<string, OnLoan>([["loan", brief]]);
function handle(kind: string): string | number {
  return (handlers.get(kind) ?? anyEvent())("Persuasion", 21);
}
console.log(handle("loan"), handle("return"), ran.join(","));

// A parameter that may be null, and a left side that is itself a call.
function pick(handler: OnLoan | null): OnEvent {
  return handler ?? detailed;
}
console.log(pick(brief) === brief, pick(null) === detailed, pick(null)("Emma", 30));
function registered(kind: string): OnLoan | undefined {
  ran.push(`lookup(${kind})`);
  return handlers.get(kind);
}
const found = registered("loan") ?? anyEvent();
const missed = registered("hold") ?? anyEvent();
console.log(found === brief, missed === detailed, ran.join(","));

// A class defaulted to its base class.
class Book {
  title: string;
  constructor(title: string) {
    this.title = title;
  }
  label(): string {
    return `book ${this.title}`;
  }
}
class Novel extends Book {
  label(): string {
    return `novel ${this.title}`;
  }
}
function shelve(kind: typeof Novel | undefined, title: string): string {
  const made = kind ?? Book;
  return `${new made(title).label()} ${made === Novel} ${made === Book}`;
}
console.log(shelve(Novel, "Emma"), "/", shelve(undefined, "Atlas"));

// A record that joins a union of records, an instance that joins its base
// class: one object, written through both names.
interface Paper {
  kind: "paper";
  pages: number;
}
interface Audio {
  kind: "audio";
  minutes: number;
}
type Edition = Paper | Audio;
function describe(edition: Edition): string {
  return edition.kind === "paper" ? `${edition.pages} pages` : `${edition.minutes} minutes`;
}
function recorded(): Edition {
  return { kind: "audio", minutes: 300 };
}
const paper: Paper = { kind: "paper", pages: 120 };
const audio = recorded();
function preferred(own: Paper | undefined, other: Edition): Edition {
  const chosen = own ?? other;
  if (chosen.kind === "paper") chosen.pages += 1;
  else chosen.minutes += 1;
  return chosen;
}
const chosen = preferred(paper, audio);
paper.pages += 10;
console.log(chosen === paper, describe(chosen), paper.pages);
console.log(preferred(undefined, audio) === audio, describe(audio));

const novel = new Novel("Emma");
const atlas = new Book("Atlas");
function reprint(own: Novel | undefined, other: Book): Book {
  const next = own ?? other;
  next.title = `${next.title}, second edition`;
  return next;
}
console.log(reprint(novel, atlas) === novel, novel.label(), atlas.label());
console.log(reprint(undefined, atlas) === atlas, atlas.label());

// Numbers, strings and booleans: 0, "" and false are present values.
function copies(count: number | undefined, note: string | number): string {
  const shown = count ?? note;
  return typeof shown === "number" ? `#${shown}` : shown;
}
function shelfMark(mark: string | null, row: number | string): string {
  const shown = mark ?? row;
  return typeof shown === "string" ? `<${shown}>` : `row ${shown}`;
}
function lent(flag: boolean | undefined, note: string | boolean): string {
  const shown = flag ?? note;
  return typeof shown === "boolean" ? `lent=${shown}` : shown;
}
console.log(copies(0, "none"), copies(undefined, "none"), copies(undefined, 2));
console.log(shelfMark("", 4), shelfMark(null, 4), shelfMark(null, "annex"));
console.log(lent(false, "unknown"), lent(undefined, "unknown"), lent(undefined, true));

// A promise whose payload type widens stays the same promise.
const dueIn = Promise.resolve(3);
function reminder(): Promise<number | string> {
  return Promise.resolve("no date");
}
const noDate = reminder();
async function due(known: Promise<number> | undefined): Promise<string> {
  const pending = known ?? noDate;
  return `${await pending} ${pending === dueIn} ${pending === noDate}`;
}

// Where a copy is meant, it is written, and Node copies too: an array of a
// narrower element type has no place in the wider array without one.
const papers: Paper[] = [paper];
const editions: Edition[] = [audio, paper];
function listed(own: Paper[] | undefined, all: Edition[]): Edition[] {
  const list = own ? [...own] : all;
  return list;
}
const copy = listed(papers, editions);
copy.push(audio);
console.log(copy.length, papers.length, listed(undefined, editions) === editions);
// With one type on both sides the left side is the result.
function either(own: Edition[] | undefined, all: Edition[]): Edition[] {
  return own ?? all;
}
const kept = either(copy, editions);
kept.push(paper);
console.log(kept === copy, copy.length, either(undefined, editions) === editions);

async function main(): Promise<void> {
  console.log(await due(dueIn), "/", await due(undefined));
}
main();
