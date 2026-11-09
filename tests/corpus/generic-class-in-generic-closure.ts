// A generic class named inside a closure of a generic function is the
// instantiation the function's type arguments name: `List<S>` inside
// `make<number>` and inside `Cell<number>` is the `List<number>` written out
// at top level. The members spell their arrays `Array<S>`: the lib's
// interface has a conditional type (`flat`), which does not depend on `S`.
class List<S> {
  items: Array<S> | null = null;
  add(v: S): void {
    const l = this.items;
    if (l === null) {
      this.items = [v];
    } else {
      l.push(v);
    }
  }
  count(): number {
    const l = this.items;
    return l === null ? 0 : l.length;
  }
}
class Cell<S> {
  value: S;
  list: List<S> | null = null;
  constructor(v: S) {
    this.value = v;
  }
  take(v: S): void {
    let l = this.list;
    if (l === null) {
      l = new List<S>();
      this.list = l;
    }
    l.add(v);
  }
  count(): number {
    const l = this.list;
    return l === null ? 0 : l.count();
  }
}
type Rec = { id: number; name: string };
type Rec2 = { name: string; id: number; extra: boolean };

// Directly, in a closure called at once, and in a closure that is returned
// and makes the list on its first call.
function direct<S>(v: S): Cell<S> {
  const c = new Cell<S>(v);
  c.take(v);
  return c;
}
function atOnce<S>(v: S): Cell<S> {
  return (() => {
    const inner = new Cell<S>(v);
    inner.list = new List<S>();
    inner.list.add(v);
    return inner;
  })();
}
function make<S>(v: S): [Cell<S>, (a: S) => void] {
  const cell = new Cell<S>(v);
  const dispatch = (a: S): void => {
    let l = cell.list;
    if (l === null) {
      l = new List<S>();
      cell.list = l;
    }
    l.add(a);
  };
  return [cell, dispatch];
}
console.log(direct<number>(1).count(), atOnce<number>(1).count(), atOnce<string>("s").value);

// One function, several type arguments: a number, two records of different
// layouts, a union. The top-level `List<number>` is the same class.
const [n, nd] = make<number>(1);
console.log(n.count());
nd(2);
nd(3);
const written: List<number> | null = n.list;
console.log(n.value, n.count(), written === null ? -1 : written.count());
const [r, rd] = make<Rec>({ id: 1, name: "a" });
rd({ id: 2, name: "b" });
const [q, qd] = make<Rec2>({ name: "z", id: 9, extra: true });
qd({ name: "y", id: 8, extra: false });
qd({ name: "x", id: 7, extra: false });
const [u, ud] = make<number | string>(1);
ud("two");
ud(3);
ud("four");
console.log(r.value.name, r.count(), q.value.extra, q.count(), u.value, u.count());

// The closure in a member of another generic class, made in its constructor.
class Holder<S> {
  cell: Cell<S>;
  dispatch: (a: S) => void;
  constructor(v: S) {
    const cell = new Cell<S>(v);
    this.cell = cell;
    this.dispatch = (a: S): void => {
      let l = cell.list;
      if (l === null) {
        l = new List<S>();
        cell.list = l;
      }
      l.add(a);
    };
  }
}
function hold<S>(v: S): Holder<S> {
  return new Holder<S>(v);
}
const h = hold<string>("first");
h.dispatch("second");
console.log(h.cell.value, h.cell.count());

// Two type parameters, one of them in an `Array<…>` member; the class named
// only as a type argument inside the returned closure (a cast helper), and
// constructed in another generic function. The action is an anonymous record.
class Cell2<S, A> {
  state: S;
  actions: Array<A> | null = null;
  constructor(s: S) {
    this.state = s;
  }
  take(a: A): void {
    const l = this.actions;
    if (l === null) {
      this.actions = [a];
    } else {
      l.push(a);
    }
  }
  count(): number {
    const l = this.actions;
    return l === null ? 0 : l.length;
  }
}
const slots: Array<object | null> = [null, null];
function kept<T extends object>(x: object): T {
  return x as T;
}
function dispatcher<S, A>(position: number): (action: A) => void {
  return (action: A): void => {
    const k = slots[position];
    if (k !== null) {
      kept<Cell2<S, A>>(k).take(action);
    }
  };
}
function mount<S, A>(position: number, s: S): [Cell2<S, A>, (action: A) => void] {
  const cell = new Cell2<S, A>(s);
  slots[position] = cell;
  return [cell, dispatcher<S, A>(position)];
}
const [m, md] = mount<number, { add: number }>(0, 1);
md({ add: 2 });
md({ add: 3 });
const [s, sd] = mount<string, number>(1, "state");
sd(4);
const actions = m.actions;
console.log(m.state, m.count(), actions === null ? 0 : actions[1].add, s.state, s.count());

// A constraint, a default, a generic method of a generic class, and closures
// in closures.
function constrained<S extends { id: number }>(v: S): [Cell<S>, (a: S) => number] {
  const cell = new Cell<S>(v);
  return [
    cell,
    (a: S): number => {
      cell.take(a);
      return a.id + cell.value.id;
    },
  ];
}
const [cc, cd] = constrained<Rec>({ id: 1, name: "a" });
console.log(cd({ id: 2, name: "b" }), cc.count());
function defaulted<S = number>(v: S): [Cell<S>, (a: S) => void] {
  const cell = new Cell<S>(v);
  return [cell, (a: S): void => cell.take(a)];
}
const [dc, dd] = defaulted(1);
dd(2);
console.log(dc.value, dc.count());
class Factory<T> {
  seed: T;
  constructor(seed: T) {
    this.seed = seed;
  }
  make<S>(v: S): [Cell<S>, (a: S) => T] {
    const cell = new Cell<S>(v);
    const dispatch = (a: S): T => {
      let l = cell.list;
      if (l === null) {
        l = new List<S>();
        cell.list = l;
      }
      l.add(a);
      return this.seed;
    };
    return [cell, dispatch];
  }
}
const factory = new Factory<string>("seed");
const [fc, fd] = factory.make<number>(1);
const [fr, frd] = factory.make<Rec>({ id: 1, name: "a" });
console.log(fd(2), fc.count(), frd({ id: 2, name: "b" }), fr.count());
function nested<S>(v: S): [Cell<S>, () => (a: S) => void] {
  const cell = new Cell<S>(v);
  const outer = (): ((a: S) => void) => {
    return (a: S): void => {
      const add = (): void => {
        let l = cell.list;
        if (l === null) {
          l = new List<S>();
          cell.list = l;
        }
        l.add(a);
      };
      add();
    };
  };
  return [cell, outer];
}
const [nc, outer] = nested<boolean>(true);
const nestedDispatch = outer();
nestedDispatch(false);
nestedDispatch(true);
console.log(nc.value, nc.count());

// A class with a real conditional member over ONE of its two parameters is
// still keyed by that argument's literal, and `this` inside it is the same
// instantiation.
type Flag<B extends boolean> = B extends true ? "on" : "off";
class Tagged<T, B extends boolean> {
  item: T;
  state: B;
  constructor(item: T, state: B) {
    this.item = item;
    this.state = state;
  }
  label(): Flag<B> {
    return (this.state ? "on" : "off") as Flag<B>;
  }
  describe(): string {
    return `${String(this.item)}:${this.label()}`;
  }
}
console.log(new Tagged(1, true).describe(), new Tagged("x", false).describe());
console.log(new Tagged(2, false).label(), new Tagged(2, true).label());
