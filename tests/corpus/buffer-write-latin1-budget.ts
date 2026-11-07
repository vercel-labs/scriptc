// Buffer#write in latin1 and ascii over a long text that mixes ASCII, BMP
// and astral characters: the budget truncates per UTF-16 code unit (so an
// astral pair can be split), the offset shifts where the bytes land, and the
// bytes written are always the first `written` bytes of Buffer.from's
// encoding of the whole text. The bytes past the write keep their fill.

const text = "café const x = 1; 本語 \u{1F600} tail\n".repeat(48);

const encodings = ["latin1", "ascii"] as const;

for (const enc of encodings) {
  const whole = Buffer.from(text, enc);
  console.log(enc, "whole", whole.length);
  for (const offset of [0, 1, 2, 3, 7, 8, 9]) {
    for (const budget of [0, 1, 2, 3, 6, 7, 8, 9, 15, 16, 17, 31, 47, 64, 255, 1000]) {
      const target = Buffer.alloc(offset + budget + 8, 0xaa);
      const written = target.write(text, offset, budget, enc);
      const tail = Buffer.alloc(target.length - offset - written, 0xaa);
      const same =
        written === Math.min(budget, whole.length) &&
        target.subarray(offset, offset + written).equals(whole.subarray(0, written)) &&
        target.subarray(offset + written).equals(tail);
      const head = target.subarray(offset, offset + Math.min(written, 12)).toString("hex");
      console.log(offset, budget, written, same, head);
    }
  }
}

// A long ASCII run with non-ASCII text behind it, written in short pieces:
// the bytes written are the run's first ones and the text after the write is
// untouched, whatever the text's length.
const prefixed = "p".repeat(20000) + "café \u{1F600} 本語" + "q".repeat(500);
for (const enc of encodings) {
  const whole = Buffer.from(prefixed, enc);
  console.log("prefixed", enc, whole.length);
  for (const offset of [0, 1, 8]) {
    for (const budget of [0, 1, 2, 3, 8, 9, 20000, 20001, 20002, 20010, 21000]) {
      const target = Buffer.alloc(offset + budget + 8, 0xaa);
      const written = target.write(prefixed, offset, budget, enc);
      const tail = Buffer.alloc(target.length - offset - written, 0xaa);
      const same =
        written === Math.min(budget, whole.length) &&
        target.subarray(offset, offset + written).equals(whole.subarray(0, written)) &&
        target.subarray(offset + written).equals(tail);
      console.log(offset, budget, written, same, target.subarray(offset, offset + 8).toString("hex"));
    }
  }
}

// The same writes with the encoding name held in a variable, including the
// upper-case spellings Node's table accepts.
const names = ["latin1", "LATIN1", "ascii", "ASCII"];
for (const name of names) {
  const enc = name as BufferEncoding;
  const target = Buffer.alloc(24, 0xaa);
  const written = target.write(text, 1, 15, enc);
  console.log("dynamic", name, written, target.toString("hex"));
}

// A write with the length left out fills the rest of the buffer.
const open = Buffer.alloc(text.length + 4, 0xaa);
console.log("open", open.write(text, 5, "latin1"), open.subarray(0, 5).toString("hex"));
const full = Buffer.alloc(text.length, 0xaa);
console.log("full", full.write(text, "ascii"), full.subarray(0, 12).toString("hex"));
