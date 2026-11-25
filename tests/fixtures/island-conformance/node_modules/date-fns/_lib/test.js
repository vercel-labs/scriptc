import { afterEach, beforeEach, vi } from "./test/vitest";
import { addLeadingZeros } from "./addLeadingZeros.js";
import { setDefaultOptions } from "./defaultOptions.js";

export function assertType(_value) {}

export function resetDefaultOptions() {
  setDefaultOptions({});
}

// This makes sure we create the consistent offsets across timezones, no matter where these tests are ran.
export function generateOffset(originalDate) {
  // Add the timezone.
  let offset = "";
  const tzOffset = originalDate.getTimezoneOffset();

  if (tzOffset !== 0) {
    const absoluteOffset = Math.abs(tzOffset);
    const hourOffset = addLeadingZeros(Math.trunc(absoluteOffset / 60), 2);
    const minuteOffset = addLeadingZeros(absoluteOffset % 60, 2);
    // If less than 0, the sign is +, because it is ahead of time.
    const sign = tzOffset < 0 ? "+" : "-";

    offset = `${sign}${hourOffset}:${minuteOffset}`;
  } else {
    offset = "Z";
  }

  return offset;
}

export function fakeDate(date) {
  function fakeNow(date) {
    vi.setSystemTime(date);
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: date });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  return { fakeNow };
}
