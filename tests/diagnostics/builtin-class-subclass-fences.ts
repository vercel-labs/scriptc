// A program class that extends a built-in class with no subclass layout is
// refused by the class's name, whether or not the heritage carries type
// arguments, and the refusal says what compiles instead.
class Timetable extends Map<string, number> {
  earliest(): number {
    let best = Infinity;
    for (const minute of this.values()) best = Math.min(best, minute);
    return best;
  }
}

class Piers extends Set<string> {
  label = "piers";
}

class Crossing extends ReadableStream<Uint8Array> {
  allAboard: Promise<void> = Promise.resolve();
}

class Arrival extends Promise<number> {
  label = "arrival";
}

class Landing extends URL {
  pier(): string {
    return this.pathname.slice(1);
  }
}

console.log(new Timetable().earliest());
console.log(new Piers().label);
console.log(new Crossing().allAboard === undefined);
console.log(new Arrival((resolve) => resolve(1)).label);
console.log(new Landing("ferry://quay/north").pier());
