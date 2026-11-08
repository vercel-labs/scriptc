// A constant table that takes the layout of the type it is read through
// holds its nested literals and the tables it names in the layouts of their
// slots. Reading such a member through the table's own type answers that
// same object: a collection keyed by the member finds it, whichever way the
// program reached it.

interface Seat {
  readonly row: number;
  readonly label?: string;
}

interface Deck {
  readonly level: number;
  readonly seats?: Seat;
  readonly best?: Seat;
}

interface Hall {
  readonly name: string;
  readonly deck?: Deck;
  readonly lobby?: Deck;
}

const corner = { row: 9 } as const;
const lobby = { level: 0, best: corner } as const;
const hall = {
  name: "north",
  deck: { level: 2, seats: { row: 1, label: "a" }, best: corner },
  lobby: lobby,
} as const;

const halls = new Map<Hall, string>();
const decks = new Map<Deck, string>();
const seats = new Map<Seat, string>();

function enter(place: Hall): void {
  halls.set(place, place.name);
  if (place.deck !== undefined) {
    decks.set(place.deck, "deck");
    if (place.deck.seats !== undefined) seats.set(place.deck.seats, "seats");
    if (place.deck.best !== undefined) seats.set(place.deck.best, "best");
  }
  if (place.lobby !== undefined) decks.set(place.lobby, "lobby");
}

function seatNamed(seat: Seat): string {
  return seats.get(seat) ?? "no seat";
}

function deckNamed(deck: Deck): string {
  return decks.get(deck) ?? "no deck";
}

enter(hall);

// The table, a nested literal, a literal inside it, and a table named twice.
console.log(halls.get(hall), deckNamed(hall.deck), seatNamed(hall.deck.seats));
console.log(seatNamed(hall.deck.best), seatNamed(corner), seatNamed(hall.lobby.best));
console.log(deckNamed(hall.lobby), deckNamed(lobby), decks.size, seats.size);

// Identity through the table's own type.
console.log(hall.lobby === lobby, hall.deck.best === corner, hall.lobby.best === hall.deck.best);

// Members the interface makes optional are present in the literal's type.
console.log(hall.deck.seats.label, hall.deck.seats.row + hall.deck.best.row);
console.log(hall.deck.level + hall.lobby.level, hall.name.length);

// What the object holds is what the literal wrote.
console.log("label" in hall.deck.best, "label" in hall.deck.seats);
console.log(Object.keys(hall.deck.seats).join(), JSON.stringify(hall.deck));

// A member handed on by a function that holds the table as its interface.
function bestOf(place: Hall): Seat | undefined {
  return place.deck?.best;
}
console.log(bestOf(hall) === hall.deck.best, bestOf(hall) === corner);

// A search for a member read through the table's own type.
const order: Seat[] = [];
function line(seat: Seat): void {
  order.push(seat);
}
line(hall.deck.seats);
line(hall.deck.best);
console.log(order.indexOf(corner), order.includes(hall.deck.seats), order.length);
