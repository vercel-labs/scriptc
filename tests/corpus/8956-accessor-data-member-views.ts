// A get/set accessor may implement a declared DATA member (tsc accepts it),
// and the mapped views of such a type must keep the accessor live exactly as
// Node does. An object literal whose member kinds disagree with its
// contextual type marks the type a checked-identity view; an intersection
// marks each disagreeing constituent, a union marks every present arm only
// when no arm can hold the literal natively, and a homomorphic mapped view
// (Omit, Pick, Partial, Readonly) marks the type it maps. Getters then run per read through the view, setters per write, and
// enumeration/JSON see the accessor. Node is the oracle byte-for-byte.

interface State {
  readonly prompt: string;
  set items(v: string[]);
  get items(): string[];
  readonly busy: boolean;
}
type Mutable = Omit<State, "busy"> & { busy: boolean };

function create(seed: string[]): Mutable {
  let items = seed.slice();
  return {
    get prompt() {
      return items.length > 0 ? items[0]! : "";
    },
    get items() {
      return items;
    },
    set items(next: string[]) {
      items = next.slice();
    },
    busy: false,
  };
}

// MutableView -> State stays identity-preserving after the view marking.
class Owner {
  private m: Mutable = create(["a", "b"]);
  get state(): State {
    return this.m;
  }
  reset(): void {
    this.m.items = ["z"];
    this.m.busy = true;
  }
}
const owner = new Owner();
console.log(owner.state.prompt, owner.state.items.length, owner.state.busy);
owner.reset();
console.log(owner.state.prompt, owner.state.items.join(","), owner.state.busy);
console.log(Object.keys(owner.state).join(","));
console.log(JSON.stringify(owner.state));

// Partial<Omit<...>> data literals stay ordinary live objects.
type Initial = Partial<Omit<State, "items" | "busy">>;
const initial: Initial = { prompt: "seed" };
console.log(initial.prompt, Object.keys(initial).join(","), JSON.stringify(initial));

// Pick and Readonly views keep the getter live too.
const picked: Pick<State, "prompt"> = create(["p", "q"]);
console.log(picked.prompt, Object.keys(picked).join(","), JSON.stringify(picked));
const readonlyState: Readonly<State> = create(["r", "s"]);
console.log(readonlyState.prompt, readonlyState.items.length, JSON.stringify(readonlyState));

// A union whose arm declares the member as data: the run-time arm is unknown,
// so every present arm keeps checked identity and the getter stays live.
interface Live {
  kind: "live";
  readonly value: number;
}
interface Fixed {
  kind: "fixed";
  value: number;
}
let counter = 0;
const items: (Live | Fixed)[] = [
  {
    kind: "live",
    get value() {
      return ++counter;
    },
  },
  { kind: "fixed", value: 7 },
];
for (const it of items) console.log(it.kind, it.value, it.value);
console.log(JSON.stringify(items));
console.log(items[0] === items[0], "value" in items[0]!);
