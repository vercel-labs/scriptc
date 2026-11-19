// A self-slicing scan re-entered by an outer loop: an outer pass that leaves
// the local where the previous pass ended must start the next scan from that
// suffix, not from unit 0 of the original string. A cursor scan may only
// start over at the loop's entry when that entry value is what the pass
// scans: a local declared inside the loop the scan sits in is a fresh
// binding each pass, and an assignment before the loop in that loop's body
// runs on every pass. A declaration in an outer loop is not rerun by an
// inner loop's pass, so that scan starts over only from where the source
// itself starts one. An outer loop that holds the scan's reads itself
// continues the scan, so the cursor spans the outer loop and starts over
// only when the function does.

function reentered(text: string, rounds: number): number {
  let rest = text;
  let n = 0;
  let round = 0;
  while (round < rounds) {
    while (rest.length > 0) {
      n = n + rest.charCodeAt(0);
      rest = rest.slice(1);
    }
    round += 1;
  }
  return n;
}

// The same re-entry from an outer `for`.
function reenteredFor(text: string): number {
  let rest = text;
  let n = 0;
  for (let i = 0; i < 3; i++) {
    while (rest.length > 1) {
      n = n + rest.indexOf("b") + rest.length;
      rest = rest.slice(1);
    }
  }
  return n;
}

// The next outer pass reinitializes the local: a new scan starts there.
function freshEachEntry(text: string, rounds: number): number {
  let rest = text;
  let n = 0;
  let round = 0;
  while (round < rounds) {
    rest = text.slice(round);
    while (rest.length > 0) {
      n = n + rest.charCodeAt(rest.length - 1);
      rest = rest.slice(1);
    }
    round += 1;
  }
  return n;
}

// A local declared inside the enclosing loop starts fresh each pass.
function declaredEachPass(text: string, rounds: number): number {
  let n = 0;
  let round = 0;
  while (round < rounds) {
    let rest = text.slice(round);
    while (rest.length > 0) {
      n = n + rest.charCodeAt(0);
      rest = rest.slice(1);
    }
    round += 1;
  }
  return n;
}

// The do-while form re-entered: a later pass runs the body once over the
// suffix the previous pass left, exactly as the source does.
function reenteredDoWhile(text: string, rounds: number): number {
  let rest = text;
  let n = 0;
  let round = 0;
  while (round < rounds) {
    do {
      n = n + rest.charCodeAt(0);
      rest = rest.slice(1);
    } while (rest.length > 0);
    round += 1;
  }
  return n;
}

// A scan whose outer loop reads the local too: the outer loop holds every
// read, so the cursor spans it and each inner pass continues the same scan.
function outerReads(text: string, rounds: number): number {
  let rest = text;
  let n = 0;
  let left = 0;
  let round = 0;
  while (round < rounds && rest.length > 0) {
    while (rest.length > 1) {
      n = n + rest.charCodeAt(1);
      rest = rest.slice(1);
    }
    rest = rest.slice(1);
    left = rest.length;
    round += 1;
  }
  return n * 100 + left;
}

// A local declared in an outer loop is not fresh on a pass of an inner
// loop: the second pass runs over the suffix the first left, and a fresh
// scan may only start where the source starts one.
function outerDeclaration(text: string): string {
  let seen = "";
  let round = 0;
  while (round < 2) {
    let rest = text;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      while (rest.length > 0) {
        seen += rest.charAt(0);
        rest = rest.slice(1);
      }
    }
    round += 1;
  }
  return seen;
}

// A local declared in the parent `for` loop's initializer runs once, not on
// every pass, so a scan re-entered by that loop continues from the suffix the
// previous pass left.
function forInitializerDeclaration(text: string): number {
  let n = 0;
  for (let rest = text, round = 0; round < 3; round += 1) {
    while (rest.length > 0) {
      n = n + rest.charCodeAt(0);
      rest = rest.slice(1);
    }
  }
  return n;
}

// A relative assignment before the scan is not a reinitialization: the
// cursor keeps the consumed suffix out of the slot, so slicing the local
// itself would start from the string the loop entered with.
function relativePrefix(text: string, prefix: number, rounds: number): number {
  let rest = text;
  let tokens = 0;
  let round = 0;
  while (round < rounds) {
    rest = rest.slice(prefix);
    while (rest.length > 0) {
      tokens += 1;
      rest = rest.slice(1);
    }
    round += 1;
  }
  return tokens;
}

const text = "abc;def;ghijkl;mn";
const other = "aaabbbccc";
console.log(reentered(text, 2), reentered(text, 5), reentered("", 3));
console.log(reenteredFor(text), reenteredFor("abcd"), reenteredFor("a"));
console.log(freshEachEntry(text, 4), freshEachEntry(other, 3));
console.log(declaredEachPass(text, 4), declaredEachPass(other, 3));
console.log(reenteredDoWhile(text, 3), reenteredDoWhile("x", 2));
console.log(outerReads(text, 3), outerReads(other, 9));
console.log(outerDeclaration("abc"), outerDeclaration(""), outerDeclaration(text));
console.log(
  forInitializerDeclaration("abcdefg"),
  forInitializerDeclaration(""),
  forInitializerDeclaration("abc"),
);
console.log(relativePrefix("abc", 0, 3), relativePrefix("abcdef", 2, 3), relativePrefix("abcde", 3, 2));
