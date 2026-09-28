class Base {
  *values(): Generator<number, void, undefined> {
    yield 1;
  }
}

class Replaced extends Base {
  *values(): Generator<number, void, undefined> {
    yield 2;
  }
}
const source: Base = new Replaced();
for (const value of source.values()) console.log(value);
