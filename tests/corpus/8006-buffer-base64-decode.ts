// Buffer.from(text, "base64" | "base64url") over complete eight-character
// blocks and the text around them: every length from 0 to 40, an invalid
// character at each position of a block, padding and text after it, both
// alphabets, line breaks every 76 characters, sizes around the pool
// threshold, and characters past U+00FF.

let seed = 7;
function next(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed >>> 8;
}
function bytes(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = next() & 255;
  return buf;
}

const rows: string[] = [];
for (let size = 0; size <= 30; size++) {
  const buf = bytes(size);
  const text = buf.toString("base64");
  const url = buf.toString("base64url");
  rows.push(
    `${size}:${text.length}:${Buffer.from(text, "base64").equals(buf)}:${Buffer.from(url, "base64url").equals(buf)}:${Buffer.from(url, "base64").equals(buf)}`,
  );
}
console.log(rows.join(" "));

const block = Buffer.from("0123456789abcdefghijklmnopqrstuv").toString("base64");
for (let at = 0; at < 16; at++) {
  for (const bad of [" ", "\n", "*", "=", "é", "中"]) {
    const text = block.slice(0, at) + bad + block.slice(at);
    console.log(at, JSON.stringify(bad), Buffer.from(text, "base64").toString("hex"));
  }
}

for (const text of [
  "QUJDREVGR0g=",
  "QUJDREVGR0",
  "QUJDREVGR0g=QUJD",
  "QUJD=REVGR0hJ",
  "QUJDREVGR0hJSktM",
  "QUJDREVGR0hJSktMTQ",
  "QUJDREVGR0hJSktMTQ==",
  "--__--__",
  "++//++//",
  "+-/_+-/_+-/_",
  "Q U J D R E V G R 0 h J",
  "QUJD\tREVG\r\nR0hJ",
  "=QUJDREVGR0hJ",
  "",
]) {
  console.log(JSON.stringify(text), Buffer.from(text, "base64").toString("hex"), Buffer.from(text, "base64url").length);
}

for (const size of [4095, 4096, 4097, 6144, 6145, 70000]) {
  const buf = bytes(size);
  const text = buf.toString("base64");
  const wrapped = text.replace(/.{76}/g, "$&\n");
  const decoded = Buffer.from(text, "base64");
  const unwrapped = Buffer.from(wrapped, "base64");
  console.log(size, decoded.length, decoded.equals(buf), unwrapped.equals(buf), Buffer.byteLength(text, "base64"));
}

const wide = "QUJDREVGR0hJİSktM";
console.log(Buffer.from(wide, "base64").toString("hex"), Buffer.from("ŁłQUJD", "base64").toString("hex"));
