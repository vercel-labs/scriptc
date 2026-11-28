// A Readable.from source whose Symbol.asyncIterator is chosen at run time:
// the native fast path drives the built-in stream state, so it applies only
// to a source whose effective iterator is the built-in one. A source whose
// iterator a guard (or a redaction) must run is refused instead of being
// consumed past it.
import { Readable } from 'stream';

class Guarded extends Readable {
  _read(): void {
    this.push('x');
    this.push(null);
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<any> {
    console.log('guard ran');
    return super[Symbol.asyncIterator]();
  }
}

// A constructor-typed value can hold a subclass's constructor: a `new`
// expression whose callee is not the class itself is not proof of the
// runtime class, so the descendant guard cannot be skipped.
function firstData(Ctor: typeof Readable): void {
  const wrapper = Readable.from(new Ctor());
  wrapper.on('data', () => {});
}
firstData(Guarded);

// A JavaScript class can shadow the method with an accessor: from.js reads
// the member off the value, so the getter runs and its answer is called.
// (The accessor declaration is what a JavaScript source can express; the
// compiler's accessor slot hides it from a method-only override check.)
class Accessor extends Readable {
  _read(): void {
    this.push('x');
    this.push(null);
  }
  // @ts-ignore -- the getter shadows the base method in a JavaScript class
  get [Symbol.asyncIterator](): any {
    return Readable.prototype[Symbol.asyncIterator];
  }
}
Readable.from(new Accessor());
