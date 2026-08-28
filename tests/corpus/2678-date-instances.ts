// @transform-types
// Stored Date values: the read-only TimeClip scalar slice. Construction,
// locals/params/returns/fields/captures, UTC and host-local getters, and
// toISOString must all match the sibling Node process byte-for-byte.

const instant = new Date("2024-07-04T12:34:56.789Z");

// The reported shape: a Date local followed by local calendar reads.
console.log(instant.getFullYear(), instant.getHours());

console.log(
  instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate(),
  instant.getUTCDay(), instant.getUTCHours(), instant.getUTCMinutes(),
  instant.getUTCSeconds(), instant.getUTCMilliseconds(),
);
console.log(
  instant.getFullYear(), instant.getMonth(), instant.getDate(),
  instant.getDay(), instant.getHours(), instant.getMinutes(),
  instant.getSeconds(), instant.getMilliseconds(), instant.getTimezoneOffset(),
);
console.log(instant.getTime(), instant.valueOf(), instant.toISOString());

function passDate(d: Date): Date {
  return d;
}

class Stamp {
  constructor(public when: Date) {}
}

const record: { when: Date } = { when: passDate(instant) };
const stamped = new Stamp(record.when);
const captured = ((d: Date) => () => d.getUTCFullYear())(stamped.when);
console.log(stamped.when.getUTCMonth(), captured());

// Date is also a scalar payload in the typed promise machinery: direct
// resolution, executor resolution, async return, and await all preserve it.
async function bounceDate(d: Date): Promise<Date> {
  await Promise.resolve();
  return d;
}
const resolved = await Promise.resolve(instant);
const executed = await new Promise<Date>((resolve) => resolve(resolved));
const bounced = await bounceDate(executed);
console.log(bounced.getTime(), bounced.getUTCMilliseconds());

// TimeClip at construction: truncate fractional milliseconds, normalize
// -0, and preserve Invalid Date as NaN for every numeric getter.
console.log(new Date(1.9).getTime(), new Date(-1.9).getTime());
function logUtcParts(edge: Date): void {
  console.log(
    edge.getUTCFullYear(), edge.getUTCMonth(), edge.getUTCDate(),
    edge.getUTCDay(), edge.getUTCHours(), edge.getUTCMinutes(),
    edge.getUTCSeconds(), edge.getUTCMilliseconds(),
  );
}
logUtcParts(new Date(-8640000000000000));
logUtcParts(new Date(8640000000000000));
const invalid = new Date("bogus");
console.log(
  invalid.getTime(), invalid.getFullYear(), invalid.getUTCFullYear(),
  invalid.getHours(), invalid.getUTCHours(), invalid.getTimezoneOffset(),
);
console.log(
  new Date("-000000-01-01T00:00:00.000Z").getTime(),
  new Date("2024-01-01T00:00:00.000+24:00").getTime(),
);

// TimeClip applies to the final UTC instant, after an explicit timezone
// offset. These local civil times begin just outside the Date range, but
// their offsets move them exactly onto its valid upper and lower bounds.
console.log(
  new Date("+275760-09-13T23:00:00.000+23:00").toISOString(),
  new Date("-271821-04-19T01:00:00.000-23:00").toISOString(),
);

// Zero-argument construction materializes a storable live Date. Assert
// stable properties rather than printing the wall-clock value itself.
const live = new Date();
console.log(
  Number.isInteger(live.getTime()),
  live.getTime() > 1700000000000,
  live.getFullYear() >= 2023,
  live.getUTCFullYear() >= 2023,
);

// Historical timezone data can have offsets with second precision, but the
// JavaScript API always exposes a whole number of minutes.
console.log(
  Number.isInteger(new Date("1800-01-01T00:00:00.000Z").getTimezoneOffset()),
);

// Some CRT localtime implementations cover only 1970..3001 even though
// ECMAScript Dates span roughly +/-275,000 years. Every local getter must
// still answer a finite integer for valid instants outside that CRT range.
function hasLocalParts(edge: Date): boolean {
  return Number.isInteger(edge.getFullYear()) &&
    Number.isInteger(edge.getMonth()) &&
    Number.isInteger(edge.getDate()) &&
    Number.isInteger(edge.getDay()) &&
    Number.isInteger(edge.getHours()) &&
    Number.isInteger(edge.getMinutes()) &&
    Number.isInteger(edge.getSeconds()) &&
    Number.isInteger(edge.getMilliseconds()) &&
    Number.isInteger(edge.getTimezoneOffset());
}
console.log(
  hasLocalParts(new Date("1800-01-01T00:00:00.000Z")),
  hasLocalParts(new Date("+005000-01-01T00:00:00.000Z")),
);
