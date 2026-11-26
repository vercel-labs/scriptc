// `.constructor` answers the instance's class, the class is a value whose
// `.name` is the class's name, and `===` compares that class: for a program
// class and for the DOM classes the runtime holds interned constructor
// values for.
class Foo {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
}
const foo = new Foo(1);
console.log(foo.constructor === Foo, foo.constructor.name);

const event = new Event('t');
console.log(event.constructor === Event, Event.name, event.constructor.name);

const custom = new CustomEvent('c');
console.log(custom.constructor === CustomEvent, CustomEvent.name, custom.constructor.name);

const target = new EventTarget();
console.log(target.constructor === EventTarget, EventTarget.name);

const abort = new AbortController();
console.log(abort.constructor === AbortController, AbortController.name);

const domEx = new DOMException('x', 'AbortError');
console.log(domEx.constructor === DOMException, DOMException.name, domEx.constructor.name);

// A stored class value keeps its identity and its name.
const C = Event;
console.log(C === Event, C.name, new Event('t').constructor === C);

// An event listener reads its event's class.
const bus = new EventTarget();
bus.addEventListener('ping', (e: Event) => {
  console.log('listener', e.constructor.name, e.type);
});
bus.dispatchEvent(new Event('ping'));

// Class values in a collection.
const kinds: unknown[] = [Event, CustomEvent, EventTarget];
console.log(kinds.length, (kinds[0] as typeof Event).name, kinds[0] === Event);
