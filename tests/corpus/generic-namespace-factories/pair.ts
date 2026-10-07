export class Pair<A, B> {
  first: A;
  second: B;
  constructor(first: A, second: B) { this.first = first; this.second = second; }
  static make<X, Y>(first: X, second: Y): Pair<X, Y> { return new Pair(first, second); }
  static choose<T>(value: T, fallback: T): T { return value ?? fallback; }
}
