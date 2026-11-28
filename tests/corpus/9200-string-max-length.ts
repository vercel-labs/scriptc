// Node 24's maximum string length is 0x1fffffe8 (2^29 - 24) UTF-16 code
// units. A growth past it throws the catchable RangeError "Invalid string
// length" and never traps the process. One quarter-sized string is shared so
// each case stays inside a quarter of the limit; Node is the oracle for every
// line, including the message.
const half = "a".repeat(268435445);
console.log(half.length);

function check(label: string, build: () => string): void {
  try {
    const built = build();
    console.log(label, "built", built.length);
  } catch (error) {
    const e = error as Error;
    console.log(label, e.name, e.message);
  }
}

check("concat", () => half + half + "b");
check("append", () => {
  let text = half;
  text += half;
  return text;
});
check("template", () => `${half}${half}x`);
check("join", () => [half, half].join(""));
check("json", () => JSON.stringify([half, half]));
check("repeat", () => "a".repeat(536870889));
check("repeat-huge", () => "a".repeat(2 ** 53));
check("padStart", () => "a".padStart(536870889));
check("padEnd", () => "a".padEnd(1e9));
// Buffer#toString refuses a result past the limit with Node's own Error
// (code ERR_STRING_TOO_LONG): hex doubles the byte length.
check("buffer-hex", () => Buffer.alloc(268435445).toString("hex"));
