// Node validates a timer callback synchronously, after every argument
// expression has evaluated and before the delay converts: a non-function
// throws ERR_INVALID_ARG_TYPE naming the received value. The callback here
// is a checked-dynamic value, so the validation happens in the runtime.

function rejection(label: string, call: (cb: unknown) => void, value: unknown): void {
  try {
    call(value);
    console.log(label, "accepted");
  } catch (e: any) {
    console.log(label, e instanceof TypeError, e.code, JSON.stringify(e.message));
  }
}

const values: [string, unknown][] = [
  ["number", 123],
  ["null", null],
  ["undefined", undefined],
  ["string", "x"],
  ["object", {}],
  ["boolean", true],
  ["bigint", 10n],
  ["symbol", Symbol("s")],
];

for (const [name, value] of values) {
  rejection(`setTimeout ${name}`, (cb) => setTimeout(cb as () => void, 1), value);
  rejection(`setInterval ${name}`, (cb) => setInterval(cb as () => void, 1), value);
  rejection(`setImmediate ${name}`, (cb) => setImmediate(cb as () => void), value);
}

// Every argument expression evaluates before the gate, in source order:
// the delay first, then the trailing arguments.
function delay(): number {
  console.log("delay expression");
  return 1;
}
function trailing(): number {
  console.log("trailing expression");
  return 7;
}
rejection(
  "ordering",
  (cb) => setTimeout(cb as (value: number) => void, delay(), trailing()),
  undefined,
);
rejection(
  "ordering immediate",
  (cb) => setImmediate(cb as (value: number) => void, trailing()),
  undefined,
);

// A function that reaches the timer through the same checked-dynamic path
// schedules normally, and the trailing arguments are delivered.
function schedule(cb: unknown): void {
  setTimeout(cb as (value: number) => void, 10, 7);
}
schedule((value: number) => console.log("trailing arguments", value));

function immediate(cb: unknown, value: number): void {
  setImmediate(cb as (value: number) => void, value);
}
immediate((value: number) => console.log("immediate argument", value), 9);

setTimeout(() => console.log("done"), 40);
