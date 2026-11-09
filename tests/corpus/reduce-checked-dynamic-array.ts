// Array.prototype.reduce and reduceRight called on an array held as a
// checked-dynamic value (an `unknown[]`, here out of JSON.parse): the call
// runs on the value's kind at run time, as map and filter do.
const gauge: unknown[] = JSON.parse('[12.5, "n/a", 7, 30.25, "n/a", 4]');

function mm(sample: unknown): number {
  return typeof sample === "number" ? sample : 0;
}

// A seed of another type than the elements, and the index parameter.
console.log(gauge.reduce<number>((sum, sample) => sum + mm(sample), 0));
console.log(gauge.reduce<number>((wettest, sample, day) => (mm(sample) > mm(gauge[wettest]) ? day : wettest), 0));
console.log(gauge.reduce<string[]>((days, sample, day) => (mm(sample) > 10 ? [...days, `day${day}`] : days), []).join(","));

// From the right.
console.log(gauge.reduceRight<string>((bar, sample) => bar + (typeof sample === "number" ? "#" : "."), ""));

// An optional receiver.
function driest(samples: unknown[] | undefined): number | undefined {
  return samples?.reduceRight<number>((low, sample) => (typeof sample === "number" && sample < low ? sample : low), Infinity);
}
console.log(driest(gauge), driest(undefined), driest([]));

// Without a seed the first element is the seed, and an empty array throws.
const words: unknown[] = JSON.parse('["fog","rain","hail"]');
console.log(String(words.reduce((joined, word) => `${String(joined)}>${String(word)}`)));
console.log(String(words.reduceRight((joined, word) => `${String(joined)}>${String(word)}`)));
const none: unknown[] = JSON.parse("[]");
for (const fromRight of [false, true]) {
  try {
    if (fromRight) none.reduceRight((kept) => kept);
    else none.reduce((kept) => kept);
    console.log("no throw");
  } catch (error) {
    console.log(error instanceof TypeError, (error as Error).message);
  }
}

// The fourth parameter is the array itself.
let sameArray = 0;
gauge.reduce<number>((count, _sample, _day, all) => {
  if (all === gauge) sameArray++;
  return count + 1;
}, 0);
console.log(sameArray);

// An error thrown by the callback leaves the call, and the walk ends there.
let visited = 0;
try {
  gauge.reduce<number>((sum, sample) => {
    visited++;
    if (typeof sample !== "number") throw new RangeError(`not a depth: ${String(sample)}`);
    return sum + sample;
  }, 0);
} catch (error) {
  console.log(error instanceof RangeError, (error as Error).message, visited);
}
