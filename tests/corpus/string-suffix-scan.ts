// A scan whose loop replaces its own string with the rest of it:
// `rest = rest.slice(k + 1)`. Every step copies the remainder, so the shape
// costs the square of the text's length. The emitter keeps the string the
// local entered the loop with and the units consumed so far, and answers
// length, indexOf, charAt, charCodeAt, slice and substring at that offset.
// The rewrite means the same string as the source does for every input: ASCII
// and astral text, fractional, negative, infinite and NaN bounds, a needle
// found at the first unit or searched from a position, suffix steps that keep
// the tail (a negative bound) and `substring` steps. The shapes the emitter
// leaves alone answer the same way too: a read after the loop, the `for`
// form, a local declared inside the loop, and a read it cannot offset (an
// argument, `includes`, a captured binding).

function tokenize(text: string): number {
  let rest = text;
  let tokens = 0;
  let checksum = 0;
  while (rest.length > 0) {
    const k = rest.indexOf(";");
    const end = k < 0 ? rest.length : k;
    const piece = rest.slice(0, end);
    tokens = tokens + 1;
    if (piece.length > 0) {
      checksum = (checksum * 31 + piece.length + piece.charCodeAt(0) * 7) % 1000003;
      checksum = (checksum + rest.charAt(end - 1).length) % 1000003;
    }
    if (k < 0) break;
    rest = rest.slice(k + 1);
  }
  return tokens * 1000000 + checksum;
}

// A needle search from a position, and a substring whose bounds it swaps.
function positions(text: string): number {
  let rest = text;
  let hits = 0;
  while (rest.length > 0) {
    hits += rest.indexOf("ab");
    hits += rest.indexOf("ab", 2);
    hits += rest.indexOf("ab", -4);
    hits += rest.indexOf("ab", 0.5);
    if (rest.substring(2, 1) === "b") hits += 1;
    rest = rest.substring(1);
  }
  return hits;
}

// Bounds are normalized against the rest of the string, exactly as slice and
// charAt normalize them against the whole one.
function bounds(text: string): number {
  let out = 0;
  let rest = text;
  while (rest.length > 0) {
    out = (out * 7 + rest.slice(-1).length + rest.slice(1.7, 2.2).length) % 65521;
    out = (out * 7 + rest.slice(Number.NaN, Number.NaN).length) % 65521;
    out = (out * 7 + rest.charAt(-0.5).length + rest.charCodeAt(-0.5)) % 65521;
    out = (out * 7 + rest.charAt(rest.length).length + rest.substring(3, 1).length) % 65521;
    const past = rest.charCodeAt(rest.length);
    if (past !== past) out = (out + 1) % 65521;
    rest = rest.slice(1);
  }
  return out;
}

// Bounds that read the whole rest: quadratic in the source's own right, so
// this one runs on a short text.
function wholeBounds(text: string): number {
  let rest = text;
  let out = 0;
  while (rest.length > 0) {
    out = (out * 7 + rest.slice(-0.5).length + rest.slice(0, Infinity).length) % 65521;
    rest = rest.slice(1);
  }
  return out;
}

// Astral text: the offset counts UTF-16 units, so a needle past a surrogate
// pair and a step through one agree with Node.
function astral(text: string): number {
  let rest = text;
  let units = 0;
  let pairs = 0;
  while (rest.length > 0) {
    const k = rest.indexOf("—");
    units += rest.length;
    if (k >= 0) pairs += rest.charCodeAt(k) > 0xffff ? 1 : 0;
    if (k < 0) break;
    rest = rest.slice(k + 1);
  }
  return units * 1000 + pairs;
}

// A step that keeps the tail, and one that asks for the whole rest.
function tails(text: string): number {
  let rest = text;
  let n = 0;
  while (rest.length > 3) {
    n += rest.length;
    rest = rest.slice(-2);
  }
  while (rest.length > 0) {
    n += rest.charCodeAt(0);
    rest = rest.slice(rest.length);
  }
  return n;
}

// The do-while form.
function doWhileScan(text: string): number {
  let rest = text;
  let n = 0;
  if (rest.length > 0) {
    do {
      n += rest.indexOf("z") + 1;
      rest = rest.slice(1);
    } while (rest.length > 0);
  }
  return n;
}

// Fractional and negative steps truncate and count from the end.
function steps(text: string): number {
  let rest = text;
  let n = 0;
  while (rest.length > 4) {
    n = (n * 3 + rest.length) % 1000003;
    rest = rest.slice(1.9);
  }
  while (rest.length > 1) {
    n = (n * 3 + rest.length) % 1000003;
    rest = rest.slice(-1);
  }
  return n;
}

// Reads after the loop: the local keeps the ordinary representation.
function afterLoop(text: string): string {
  let rest = text;
  while (rest.length > 0) rest = rest.slice(1);
  return rest + "|" + rest.length;
}

// The `for` form.
function forScan(text: string): number {
  let rest = text;
  let n = 0;
  for (let i = 0; i < 6 && rest.length > 0; i++) {
    n += rest.indexOf("a") + rest.length;
    rest = rest.slice(1);
  }
  return n + rest.length;
}

// A fresh binding each pass, re-read at the loop's entry.
function freshEachPass(text: string): number {
  let round = 0;
  let total = 0;
  while (round < 4) {
    let rest = text.slice(round);
    while (rest.length > 2) {
      total += rest.indexOf("b") + rest.length;
      rest = rest.slice(1);
    }
    round += 1;
  }
  return total;
}

// A local declared inside the loop.
function declareInsideLoop(text: string): number {
  let total = 0;
  let n = 3;
  while (n > 0) {
    let rest = text;
    total += rest.length;
    rest = rest.slice(1);
    n -= 1;
  }
  return total;
}

// A read the emitter cannot offset keeps the ordinary representation.
function withIncludes(text: string): number {
  let rest = text;
  let n = 0;
  while (rest.length > 0) {
    n += rest.includes("q") ? 1 : 0;
    rest = rest.slice(1);
  }
  return n;
}

function consume(s: string): number {
  return s.length;
}

function passedToCall(text: string): number {
  let rest = text;
  let n = 0;
  while (rest.length > 0) {
    n += consume(rest);
    rest = rest.slice(1);
  }
  return n;
}

// A closure over the local keeps the ordinary representation.
function captured(text: string): number {
  let rest = text;
  let n = 0;
  const size = (): number => rest.length;
  while (rest.length > 0) {
    n += size();
    rest = rest.slice(1);
  }
  return n;
}

// A nested loop inside the versioned one, and a branch that steps twice.
function nested(text: string): number {
  let rest = text;
  let n = 0;
  while (rest.length > 0) {
    let probe = rest.slice(0, 4);
    while (probe.length > 0) {
      n += probe.length;
      probe = probe.slice(1);
    }
    if (rest.length % 5 === 0) {
      n += 1;
      rest = rest.slice(1);
      continue;
    }
    rest = rest.slice(2);
  }
  return n;
}

// A try/finally inside the versioned loop.
function withTry(text: string): number {
  let rest = text;
  let n = 0;
  while (rest.length > 0) {
    try {
      if (rest.charAt(0) === "!") throw new Error("bang");
      n += rest.charCodeAt(0);
    } catch {
      n += 1;
    } finally {
      n += rest.length > 100 ? 0 : 1;
    }
    rest = rest.slice(1);
  }
  return n;
}

function repeat(unit: string, times: number): string {
  let text = "";
  for (let i = 0; i < times; i++) text += unit;
  return text;
}

const ascii = repeat("alpha;beta;gamma;delta;epsilon;zeta;eta;theta;iota;kappa;", 400);
const wide = repeat("a—b😀c—d;éf;", 200);
const short = "abcabcabz;abab";

console.log(ascii.length, tokenize(ascii));
console.log(tokenize(short), tokenize(""), tokenize(";"), tokenize("no-delimiter"));
console.log(positions(short), positions("abababab"), positions("xxabyyab"));
console.log(bounds(short), wholeBounds(short));
console.log(ascii.length, bounds(ascii));
console.log(wide.length, astral(wide), astral(short));
console.log(tails(short), ascii.length, tails(ascii));
console.log(doWhileScan(short), doWhileScan(ascii));
console.log(steps(short), steps(ascii));
console.log(afterLoop(short), afterLoop(""));
console.log(forScan(short), forScan(ascii));
console.log(freshEachPass(short), freshEachPass(ascii));
console.log(declareInsideLoop(short));
console.log(withIncludes("quiet;quill"), withIncludes(short));
console.log(passedToCall(short), captured(short));
console.log(nested(short), nested(ascii.slice(0, 500)));
console.log(withTry("a!b!c"), withTry(ascii.slice(0, 300)));
