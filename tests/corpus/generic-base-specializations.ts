class Root { label = 'root'; root(): string { return this.label; } }
class Pair<A, B> extends Root {
  first: A;
  second: B;
  constructor(first: A, second: B) { super(); this.first = first; this.second = second; }
  read(): A { return this.first; }
  get tail(): B { return this.second; }
  static nameOf(): string { return 'pair'; }
}
class Flipped<X, Y> extends Pair<Y, X> {
  extra: X;
  constructor(x: X, y: Y) { super(y, x); this.extra = x; }
  override read(): Y { return super.read(); }
}
class Nested<T> extends Flipped<T[], T> { }
function pairValue<A,B>(pair: Pair<A,B>): A { return pair.read(); }
const numberPair = new Flipped('tail', 7);
const stringPair = new Flipped(9, 'head');
console.log(pairValue(numberPair), numberPair.tail, numberPair.extra, numberPair.root());
console.log(pairValue(stringPair), stringPair.tail, stringPair.extra);
const nested = new Nested([1,2], 3);
console.log(nested.read(), nested.tail.join(','), nested.extra.join(','));
console.log(numberPair instanceof Pair, numberPair instanceof Flipped, numberPair instanceof Root, numberPair instanceof Nested);
console.log(nested instanceof Pair, nested instanceof Flipped, nested instanceof Nested, nested instanceof Root);
console.log(Flipped.nameOf(), Nested.nameOf());
const erased: Root = numberPair;
const recovered = erased as Flipped<string, number>;
console.log(recovered === numberPair, recovered.extra);
try { throw nested; } catch (e) { console.log(e instanceof Nested, e instanceof Flipped, e instanceof Pair, e instanceof Root); }
function familyTest(value: Root, target: new (x: string, y: number) => Flipped<string, number>): boolean { return value instanceof target; }
const plainPair = new Pair(3, 'plain');
console.log(familyTest(numberPair, Flipped), familyTest(stringPair, Flipped), familyTest(nested, Flipped), familyTest(plainPair, Flipped));
try { throw plainPair; } catch (e) { console.log(e instanceof Flipped, e instanceof Pair); }
