// for-of over STRINGS: JS's string iterator walks code POINTS — each pass
// binds the whole character, so astral chars arrive as one two-unit string
// (where charAt/slice would truncate the halves). Desugars over a byte
// cursor with the cpAtByte step intrinsic.
for (const ch of "héllo 🎉x") console.log(ch, ch.length);

// The empty string iterates zero times.
let count = 0;
for (const _c of "") count++;
console.log("empty:", count);

// break/continue ride the desugar (the advance happens BEFORE the body,
// so continue never sticks on one character).
const parts: string[] = [];
for (const ch of "a🎈b🎈c") {
  if (ch === "🎈") continue;
  parts.push(ch);
}
console.log(parts.join("|"));
for (const ch of "abcdef") {
  if (ch === "c") break;
  console.log(ch);
}

// The loop variable is per-iteration (closures capture distinct values).
let captured: (() => string) | null = null;
for (const ch of "x🎉z") {
  if (ch === "🎉") captured = () => ch;
}
console.log(captured !== null ? captured() : "none");

// Nested string loops compose, and the iterated expression evaluates ONCE.
let acc = "";
for (const a of "ab") for (const b of "12") acc += a + b + ";";
console.log(acc);
let calls = 0;
function make(): string {
  calls++;
  return "ok🎉";
}
for (const ch of make()) console.log(ch);
console.log("calls:", calls);

// Unit-level agreement over the iterated characters: BMP chars are one
// unit, astral chars two (charCodeAt(1) of a one-unit char is NaN).
for (const ch of "aé🎈") console.log(ch.charCodeAt(0), ch.charCodeAt(1));

// Combining marks are their own code points (é as e + U+0301 iterates as
// two characters; the precomposed é above is one).
let combined = 0;
for (const _ch of "é") combined++;
console.log("combining:", combined);

// A config-parser shape: walking quoted/escaped command text (the real
// pattern this lowering unblocks).
function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === " ") {
      if (current.length > 0) args.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.length > 0) args.push(current);
  return args;
}
console.log(splitCommand('run "hello world" a\\ b 🎉').join(","));
console.log("done");
