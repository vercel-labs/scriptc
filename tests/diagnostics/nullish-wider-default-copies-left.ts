// `left ?? right` where the default's type is wider than the left side's
// value and that value reaches the wider type only as a copy. JavaScript
// answers the left side's own object, so a copy would lose a write through
// either name and would not be identical to it: each form is refused, and
// the message names the copy. (Corpus nullish-wider-default-keeps-left pins
// the forms that keep the value, and the explicit copy.)
interface Paper {
  kind: "paper";
  pages: number;
}
interface Audio {
  kind: "audio";
  minutes: number;
}
type Edition = Paper | Audio;
function catalogue(): Edition[] {
  return [{ kind: "audio", minutes: 300 }];
}
const editions = catalogue();

// An array entering an array of a wider element type: an optional member,
// a lookup, a parameter that may be null.
interface Shelf {
  papers?: Paper[];
}
function onShelf(shelf: Shelf): Edition[] {
  return shelf.papers ?? editions;
}
const rooms = new Map<string, Paper[]>();
function inRoom(room: string): Edition[] {
  return rooms.get(room) ?? editions;
}
function borrowed(papers: Paper[] | null): number {
  const list = papers ?? editions;
  return list.length;
}

// A tuple entering an array.
interface Loan {
  span?: [number, number];
}
function days(loan: Loan, usual: number[]): number[] {
  return loan.span ?? usual;
}
const spans = new Map<string, [number, number]>();
function spanOf(title: string, usual: number[]): number[] {
  return spans.get(title) ?? usual;
}

// A record entering another record layout: a member of a wider type, and
// fewer members.
interface Counted {
  title: string;
  copies: number;
}
interface Estimated {
  title: string;
  copies: number | string;
}
interface Titled {
  title: string;
}
const stock = new Map<string, Counted>();
function estimate(title: string, guess: Estimated): Estimated {
  return stock.get(title) ?? guess;
}
interface Order {
  item?: Counted;
}
function ordered(order: Order, other: Titled): Titled {
  return order.item ?? other;
}

// A class instance entering a record type.
class Member {
  name: string;
  loans: number;
  constructor(name: string) {
    this.name = name;
    this.loans = 0;
  }
}
interface Named {
  name: string;
}
function holder(member: Member | undefined, guest: Named): Named {
  return member ?? guest;
}

// A promise stays the same promise, but its payload would be copied when
// it settles.
function pending(own: Promise<Paper[]> | undefined, all: Promise<Edition[]>): Promise<Edition[]> {
  return own ?? all;
}

console.log(
  onShelf({}).length,
  inRoom("east").length,
  borrowed(null),
  days({}, [14]).length,
  spanOf("Emma", [14]).length,
  estimate("Emma", { title: "Emma", copies: "a few" }).copies,
  ordered({}, { title: "Atlas" }).title,
  holder(undefined, { name: "guest" }).name,
  pending(undefined, Promise.resolve(editions)) !== undefined,
);
