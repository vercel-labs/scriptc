// A JavaScript comparator that falls off its end answers `undefined` for
// equal elements — the shape semver's `rcompare` has. JavaScript reads a
// comparator's result with ToNumber, so that value compares as NaN: every
// `< 0` / `> 0` test is false and the pair keeps its order. The compiled
// comparator completes the same way, so both lines print what Node prints.
function cmp(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
}

const versions = ["1.2.0", "1.2.0", "0.9.1", "1.10.0", "1.0.0"];
console.log(versions.slice().sort(cmp).join(","));
console.log(versions.slice().sort((a, b) => cmp(b, a)).join(","));
console.log(versions.slice().sort((a, b) => cb(a, b)).join(","));

function cb(a, b) {
  return cmp(a, b);
}
