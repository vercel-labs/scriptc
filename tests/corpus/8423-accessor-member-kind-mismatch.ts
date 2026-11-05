// An object literal whose get/set accessor satisfies a declared DATA member
// keeps the accessor live through the declared type, as in Node: every read
// calls the getter, a write calls the setter, Object.keys lists the accessor
// name in declaration order, and JSON.stringify calls the getter. The
// mirrored direction (a data property satisfying a declared accessor member)
// keeps the declared accessor's identity too.

interface Counter {
  label: string;
  size: number;
}

// A recomputed getter and a setter that both observe later state.
function makeCounter(label: string): Counter {
  let value = 1;
  return {
    get size(): number {
      console.log("get size");
      return value;
    },
    set size(next: number) {
      console.log("set size", next);
      value = next * 2;
    },
    label,
  };
}

// The value passes onward to other typed slots of the declared type.
function readTwice(counter: Counter): number {
  return counter.size + counter.size;
}

function bump(counter: Counter): void {
  counter.size = counter.size + 1;
}

const counter = makeCounter("counter");
console.log("read", counter.size, counter.label);
bump(counter);
console.log("stored", counter.size);
console.log("keys", Object.keys(counter).join(","));
console.log("json", JSON.stringify(counter));
console.log("twice", readTwice(counter));

// A getter that throws until the object observes later state.
interface Gate {
  value: number;
}

interface GateHost {
  gate: Gate;
  open: () => void;
}

function makeGate(): GateHost {
  let open = false;
  const gate: Gate = {
    get value(): number {
      if (!open) throw new Error("inactive");
      return 7;
    },
  };
  return { gate, open: () => (open = true) };
}

const host = makeGate();
try {
  console.log(host.gate.value);
} catch (error) {
  console.log("threw", error instanceof Error ? error.message : "?");
}
host.open();
console.log("open", host.gate.value, host.gate.value);

// The mirrored direction: a data literal satisfying a declared accessor.
interface Live {
  readonly label: string;
  get size(): number;
}

function readLive(live: Live): string {
  return live.label + ":" + live.size;
}

function decorate(label: string, size: number): Live {
  return { label, size };
}

const live = decorate("plain", 5);
console.log("live", readLive(live));
console.log("live-keys", Object.keys(live).join(","));
console.log("live-json", JSON.stringify(live));
