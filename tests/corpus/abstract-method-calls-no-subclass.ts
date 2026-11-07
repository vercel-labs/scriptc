// A class whose concrete methods call its abstract ones, in a program that
// never subclasses it: no instance can exist, so those calls never run. As in
// JavaScript, an abstract declaration has no value at run time; a call that
// reached one would evaluate its receiver and its arguments, then throw a
// TypeError, and the rest of the program compiles around it.

abstract class Source {
  prepare(_width: number): void {}
  abstract count(): number;
  abstract line(index: number, width: number): string;

  liveFrom(): number {
    return this.count();
  }

  first(width: number): string {
    return this.line(0, width);
  }
}

class Run {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

class Shelf {
  source: Source | null = null;
  runs: Run[] = [new Run("one"), new Run("two")];
}

const shelf = new Shelf();
console.log(shelf.runs.map((r) => r.text).join(","));
console.log(shelf.source === null ? "no source" : String(shelf.source.liveFrom()));
const pick = (s: Source | null): string => (s === null ? "none" : s.first(80));
console.log(pick(shelf.source));
