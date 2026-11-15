// Generic generator methods of a class, sync and async, instance, static
// and private: each call lowers the method for its type arguments, as a
// generic generator function's call does. A class that declares one keeps
// its fields and other methods.
class Deck {
  label = "deck";
  dealt = 0;
  returned = 0;

  // A sync generic generator that writes a field.
  *deal<T>(cards: T[], size: number): Generator<T[]> {
    for (let at = 0; at < cards.length; at += size) {
      this.dealt += 1;
      yield cards.slice(at, at + size);
    }
  }

  async reversed<T>(cards: T[]): Promise<T[]> {
    return [...cards].reverse();
  }

  // An async generic generator that awaits another generic method.
  async *rounds<T>(cards: T[], count: number): AsyncGenerator<T[]> {
    let hand = cards;
    for (let round = 0; round < count; round++) {
      hand = await this.reversed(hand);
      yield hand;
    }
  }

  // Ended early by its consumer: the finally block runs.
  async *endless<T>(make: (turn: number) => T): AsyncGenerator<T> {
    try {
      for (let turn = 0; ; turn++) {
        await null;
        yield make(turn);
      }
    } finally {
      this.returned += 1;
    }
  }

  *#indexed<T>(cards: T[]): Generator<[number, T]> {
    let index = 0;
    for (const card of cards) yield [index++, card];
  }

  numbered(cards: string[]): string {
    return [...this.#indexed(cards)].map(([index, card]) => `${index}:${card}`).join(" ");
  }

  name(): string {
    return `${this.label}/${this.dealt}`;
  }
}

class Shoe extends Deck {
  label = "shoe";
  opening(): string {
    return [...this.deal([1, 2, 3, 4], 2)].map((hand) => hand.join("+")).join(" ");
  }
}

class Sorter {
  // Delegation, a return value, and the iterator protocol by hand.
  *flat<T>(pile: T | T[]): Generator<T, number> {
    if (Array.isArray(pile)) {
      let count = 0;
      for (const inner of pile) count += yield* this.flat<T>(inner);
      return count;
    }
    yield pile;
    return 1;
  }

  static *pairs<T>(items: T[]): Generator<[T, T]> {
    for (let at = 0; at + 1 < items.length; at += 2) yield [items[at]!, items[at + 1]!];
  }

  static async *slowly<T>(items: T[]): AsyncGenerator<T> {
    for (const item of items) {
      await null;
      yield item;
    }
  }
}

const deck = new Deck();
console.log(deck.name());
for (const hand of deck.deal(["A", "K", "Q", "J", "10"], 2)) console.log(hand.join(" "));
for (const hand of deck.deal([7, 8, 9], 3)) console.log(hand.length, hand[0]);
for await (const hand of deck.rounds([1, 2, 3], 2)) console.log(hand.join(""));
for await (const hand of deck.rounds([{ suit: "h" }, { suit: "s" }], 1)) console.log(hand[0]!.suit);
for await (const value of deck.endless((turn) => ({ turn }))) {
  if (value.turn === 2) break;
}
for await (const value of deck.endless((turn) => `t${turn}`)) {
  if (value === "t1") break;
}
console.log(deck.name(), deck.returned, deck.numbered(["x", "y"]));
console.log(new Shoe().opening(), new Shoe().name());

const sorter = new Sorter();
const walk = sorter.flat<number>([4, 5, 6]);
const seen: number[] = [];
let step = walk.next();
while (!step.done) {
  seen.push(step.value);
  step = walk.next();
}
console.log(seen.join(","), step.value);
for (const [left, right] of Sorter.pairs([1, 2, 3, 4, 5])) console.log(left + right);
for (const [left, right] of Sorter.pairs(["a", "b"])) console.log(left + right);
for await (const item of Sorter.slowly([{ id: 1 }, { id: 2 }])) console.log(item.id);
