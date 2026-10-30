import { publish } from "@scriptc/threads";

class Payload {
  label: string;
  constructor(label: string) {
    console.log("construct", label);
    this.label = label;
  }
}

class Holder {
  slot: Payload | null = null;
}

function attempt(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "allowed");
  } catch (error) {
    console.log(label, error instanceof TypeError ? "TypeError" : (error as Error).message);
  }
}

function value(label: string, empty: boolean): Payload | null {
  console.log("rhs", label);
  return empty ? null : new Payload(label);
}

function write(holder: Holder, label: string, empty: boolean): void {
  holder.slot = value(label, empty);
}

const shared = publish(new Holder());
attempt("call ref", () => write(shared, "call ref", false));
attempt("call null", () => write(shared, "call null", true));
attempt("wrapped ref", () => {
  shared.slot = new Payload("wrapped ref");
});
function fail(): Payload | null {
  console.log("rhs throws");
  throw new Error("rhs failure");
}
attempt("throw order", () => {
  shared.slot = fail();
});

function writeArgument(holder: Holder, next: Payload | null): void {
  holder.slot = next;
}
const borrowed = new Payload("borrowed");
// Set keys keep this union boxed; Holder.slot then uses the field-specific
// nullable representation rather than the whole-program pointer encoding.
const keyed = new Set<Payload | null>();
keyed.add(borrowed);
keyed.add(null);
console.log("keyed payload", keyed.has(borrowed), keyed.has(null));
attempt("borrowed ref", () => writeArgument(shared, borrowed));
console.log("still borrowed", borrowed.label, shared.slot === null);

const mutable = new Holder();
let receiver = shared;
function retarget(): Payload | null {
  console.log("rhs retarget");
  receiver = mutable;
  return new Payload("retarget");
}
attempt("receiver order", () => {
  receiver.slot = retarget();
});
console.log("receivers", receiver === mutable, shared.slot === null, mutable.slot === null);

const during = new Holder();
function publishDuringRhs(): Payload | null {
  console.log("rhs publishes");
  publish(during);
  return new Payload("after publish");
}
attempt("publish during rhs", () => {
  during.slot = publishDuringRhs();
});
console.log("during unchanged", during.slot === null);
