// A Buffer view over a typed array that a JavaScript class keeps in a
// declared field without an initializer: the field holds a dynamic value,
// and the view shares the array's storage.

class Units {
  text;
  chars;
  constructor(text, onDemand) {
    this.text = text;
    if (onDemand) this.chars = new Uint16Array(text.length + 4);
    else this.chars = toUnits(text);
  }
  load(from, to) {
    Buffer.from(this.chars.buffer, from * 2, (to - from) * 2).write(
      this.text.substring(from, to),
      "utf16le",
    );
    return this.chars[from];
  }
}

function toUnits(text) {
  const units = new Uint16Array(text.length + 4);
  for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i);
  return units;
}

const lazy = new Units("hello", true);
console.log(lazy.chars[1], lazy.load(1, 3), lazy.chars[2], lazy.chars[3]);
const view = Buffer.from(lazy.chars.buffer, 2, 4);
view[0] = 0x41;
console.log(lazy.chars[1], view.length, view.toString("utf16le"));
const eager = new Units("yo", false);
console.log(eager.chars[0], eager.load(0, 2));
try {
  Buffer.from(lazy.chars.buffer, 64, 2);
} catch (error) {
  console.log(error.name);
}
