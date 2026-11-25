// A generic async generator method of a class, beside its ordinary methods: `for await` over it,
// an early `break` (the generator's `finally` runs), and an exception thrown inside it.
class Deck {
  dealt = 0;
  log: string[] = [];
  cut(at: number): number {
    return (at * 7) % 13;
  }
  async *hands<T>(size: number, card: (rank: number) => T): AsyncGenerator<T[]> {
    try {
      for (let start = 0; start < 6; start += size) {
        await Promise.resolve();
        const hand: T[] = [];
        for (let i = 0; i < size; i++) hand.push(card(this.cut(start + i)));
        this.dealt += size;
        yield hand;
      }
    } finally {
      this.log.push(`closed at ${this.dealt}`);
    }
  }
  async *misdeal<T>(card: T): AsyncGenerator<T> {
    yield card;
    throw new Error(`misdeal after ${this.dealt}`);
  }
}
const deck = new Deck();
const ranks: number[] = [];
for await (const hand of deck.hands(2, (rank) => rank)) ranks.push(...hand);
console.log(ranks.join(","), deck.dealt, deck.log.join(";"), deck.cut(3));
const names: string[] = [];
for await (const hand of deck.hands(3, (rank) => `r${rank}`)) {
  names.push(...hand);
  if (names.length >= 3) break;
}
console.log(names.join(","), deck.dealt, deck.log.join(";"));
try {
  for await (const card of deck.misdeal("joker")) console.log("got", card);
} catch (e) {
  console.log("caught", (e as Error).message);
}
