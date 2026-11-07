// An object literal that implements a declared data member with an accessor
// is the live object behind its declared type. Its other members hold what
// the declared type says they hold, not what their initializers suggest:
// `current: undefined` takes a message later, `items: []` is a `string[]`
// the program pushes to through any reference, `total: 0` takes a string.
// Each literal reaches its declared type one of four ways: returned, bound
// to an annotated declaration, passed as an argument, stored in a class
// field.

interface Msg {
  role: string;
  text: string;
}
interface Box {
  readonly size: number;
  label: string;
  current?: Msg;
  last: Msg | null;
  items: string[];
  counts: Record<string, number>;
  total: number | string;
  meta: { tag?: string; depth: number | null };
}

let n = 1;

function returned(): Box {
  return {
    get size() {
      return n;
    },
    label: "returned",
    current: undefined,
    last: null,
    items: [],
    counts: {},
    total: 0,
    meta: { tag: undefined, depth: null },
  };
}

const bound: Box = {
  get size() {
    return n * 2;
  },
  label: "bound",
  current: undefined,
  last: null,
  items: [],
  counts: {},
  total: 0,
  meta: { tag: undefined, depth: null },
};

function keep(box: Box): Box {
  return box;
}
const passed = keep({
  get size() {
    return n * 3;
  },
  label: "passed",
  current: undefined,
  last: null,
  items: [],
  counts: {},
  total: 0,
  meta: { tag: undefined, depth: null },
});

class Holder {
  box: Box = {
    get size() {
      return n * 4;
    },
    label: "field",
    current: undefined,
    last: null,
    items: [],
    counts: {},
    total: 0,
    meta: { tag: undefined, depth: null },
  };
}

function show(tag: string, box: Box): void {
  console.log(
    tag,
    box.label,
    box.size,
    box.current?.text,
    box.last === null ? null : box.last.role,
    `${box.items.join(",")}/${box.items.length}`,
    JSON.stringify(box.counts),
    typeof box.total,
    box.total,
    box.meta.tag,
    box.meta.depth,
  );
}

function store(box: Box): void {
  box.current = { role: "user", text: "hi" };
  box.last = box.current;
  box.items.push("p");
  const held = box.items;
  held.push("q");
  console.log("one array", held === box.items, box.items.length);
  box.counts["k"] = 1;
  const counts = box.counts;
  counts["j"] = 2;
  box.total = "many";
  box.meta.tag = "t";
  const meta = box.meta;
  meta.depth = 3;
  console.log("one record", meta === box.meta, box.last === box.current);
}

function replace(box: Box): void {
  box.current = undefined;
  box.last = null;
  box.items = ["a", "b", "c"];
  const held = box.items;
  held.push("d");
  box.counts = { z: 9 };
  box.total = 2.5;
  box.meta = { depth: 1 };
  const meta = box.meta;
  meta.tag = "u";
}

for (const box of [returned(), bound, passed, new Holder().box]) {
  show("initial", box);
  store(box);
  n++;
  show("stored", box);
  replace(box);
  show("replaced", box);
  console.log(Object.keys(box).join(","));
  console.log(JSON.stringify(box));
}

// The literal checked with `satisfies` before it is returned, and one in an
// array of the declared type that leaves an optional member out.
interface Slot {
  readonly id: number;
  value?: Msg;
}
function checked(): Slot {
  return {
    get id() {
      return n;
    },
    value: undefined,
  } satisfies Slot;
}
const slots: Slot[] = [
  checked(),
  {
    get id() {
      return n * 10;
    },
  },
];
for (const slot of slots) slot.value = { role: "tool", text: `t${slot.id}` };
n = 7;
console.log(slots.map((slot) => `${slot.id}:${slot.value?.text}`).join(" "));
console.log(slots.map((slot) => Object.keys(slot).join("+")).join(" "));

// A state object with accessors over captured bindings beside members that
// start empty, owned by a class that stores into it.
interface State {
  items: string[];
  readonly count: number;
  busy: boolean;
  error?: string;
  streaming?: Msg;
}
function create(): State {
  let items: string[] = [];
  return {
    get items() {
      return items;
    },
    set items(next: string[]) {
      items = next.slice();
    },
    get count() {
      return items.length;
    },
    busy: false,
    error: undefined,
    streaming: undefined,
  };
}
class Agent {
  private state: State = create();
  get view(): State {
    return this.state;
  }
  start(message: Msg): void {
    this.state.busy = true;
    this.state.streaming = message;
    this.state.items = [message.text];
  }
  end(error?: string): void {
    this.state.streaming = undefined;
    this.state.error = error;
    this.state.busy = false;
  }
}
const agent = new Agent();
agent.start({ role: "assistant", text: "hello" });
console.log(agent.view.streaming?.text, agent.view.count, agent.view.busy, agent.view.error);
agent.end("boom");
console.log(agent.view.streaming?.text, agent.view.count, agent.view.busy, agent.view.error);
