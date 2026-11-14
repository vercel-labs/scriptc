// A self-slicing scan re-entered by an outer loop: an outer pass that leaves
// the local where the previous pass ended must start the next scan from that
// suffix, not from unit 0 of the original string. A cursor scan may only
// start over at the loop's entry when that entry value is what the pass
// scans: a local declared inside an enclosing loop is a fresh binding each
// pass, and an assignment before the loop in the enclosing loop's body runs
// on every pass. An outer loop that holds the scan's reads itself continues
// the scan, so the cursor spans the outer loop and starts over only when the
// function does.

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

const text = "abc;def;ghijkl;mn";
const other = "aaabbbccc";
console.log(reentered(text, 2), reentered(text, 5), reentered("", 3));
console.log(reenteredFor(text), reenteredFor("abcd"), reenteredFor("a"));
console.log(freshEachEntry(text, 4), freshEachEntry(other, 3));
console.log(declaredEachPass(text, 4), declaredEachPass(other, 3));
console.log(reenteredDoWhile(text, 3), reenteredDoWhile("x", 2));
console.log(outerReads(text, 3), outerReads(other, 9));
