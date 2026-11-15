// @requires-icu
// @env: LC_ALL=en_US.UTF-8,TZ=UTC
// Intl.NumberFormat's digit options (integer, fraction and significant
// digits, the rounding priority, mode and increment, trailing zeros), the
// useGrouping and signDisplay values with their boolean and string forms,
// and numbering systems: one ICU has, one it does not, an algorithmic one.
const VALUES: number[] = [0, -0, 1, -1, 0.5, 1.005, 1234.5678, -1234567.891, 0.000123, 1e21, 123456789012345680000, NaN, Infinity, -Infinity, 0.045, 99.995, 1e-7, 5, 1500, 999999, 1000000, 1.5e9, 0.1 + 0.2, 12, 0.999, 2.5, 3.5, -2.5, 1e6, 0.00001234];
function row(label: string, f: Intl.NumberFormat): void {
  console.log(label + ": " + VALUES.map((v) => f.format(v)).join(" | "));
}
function attempt(label: string, make: () => string): void {
  try {
    console.log(label + " => " + make());
  } catch (e) {
    const err = e as Error;
    console.log(label + " !! " + err.name + ": " + err.message);
  }
}

function digits(): void {
  for (const minimumIntegerDigits of [1, 3, 21]) row("mnid " + minimumIntegerDigits, new Intl.NumberFormat("en-US", { minimumIntegerDigits }));
  for (const [minimumFractionDigits, maximumFractionDigits] of [[0, 0], [0, 1], [2, 2], [1, 5], [0, 20], [3, 100]]) {
    row("fd " + minimumFractionDigits + "-" + maximumFractionDigits, new Intl.NumberFormat("en-US", { minimumFractionDigits, maximumFractionDigits }));
  }
  row("mnfd 5", new Intl.NumberFormat("en-US", { minimumFractionDigits: 5 }));
  row("mxfd 0", new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }));
  row("USD mxfd 0", new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }));
  row("USD mnfd 3", new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 3 }));
  row("percent mnfd 1", new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1 }));
  for (const [minimumSignificantDigits, maximumSignificantDigits] of [[1, 1], [1, 3], [3, 3], [2, 21], [21, 21]]) {
    row("sd " + minimumSignificantDigits + "-" + maximumSignificantDigits, new Intl.NumberFormat("en-US", { minimumSignificantDigits, maximumSignificantDigits }));
  }
  row("mnsd 4", new Intl.NumberFormat("en-US", { minimumSignificantDigits: 4 }));
  row("mxsd 2", new Intl.NumberFormat("en-US", { maximumSignificantDigits: 2 }));
  for (const roundingPriority of ["auto", "morePrecision", "lessPrecision"] as const) {
    row("priority " + roundingPriority, new Intl.NumberFormat("en-US", { roundingPriority, maximumSignificantDigits: 3, maximumFractionDigits: 1 }));
    row("priority " + roundingPriority + " bare", new Intl.NumberFormat("en-US", { roundingPriority }));
    row("priority " + roundingPriority + " mins", new Intl.NumberFormat("en-US", { roundingPriority, minimumSignificantDigits: 2, minimumFractionDigits: 2 }));
  }
  for (const roundingMode of ["ceil", "floor", "expand", "trunc", "halfCeil", "halfFloor", "halfExpand", "halfTrunc", "halfEven"] as const) {
    row("mode " + roundingMode, new Intl.NumberFormat("en-US", { roundingMode, maximumFractionDigits: 0 }));
    row("mode " + roundingMode + " 2", new Intl.NumberFormat("en-US", { roundingMode, maximumFractionDigits: 2 }));
  }
  for (const [roundingIncrement, digits] of [[5, 2], [10, 2], [25, 2], [50, 1], [2, 0], [100, 0], [5000, 3], [5, 0]]) {
    row("increment " + roundingIncrement + "/" + digits, new Intl.NumberFormat("en-US", { roundingIncrement: roundingIncrement as 5, minimumFractionDigits: digits, maximumFractionDigits: digits }));
  }
  row("strip", new Intl.NumberFormat("en-US", { trailingZeroDisplay: "stripIfInteger", minimumFractionDigits: 2 }));
  row("strip USD", new Intl.NumberFormat("en-US", { trailingZeroDisplay: "stripIfInteger", style: "currency", currency: "USD" }));
  row("strip sig", new Intl.NumberFormat("en-US", { trailingZeroDisplay: "stripIfInteger", minimumSignificantDigits: 3 }));
}

function groupingAndSign(): void {
  row("grouping true", new Intl.NumberFormat("en-US", { useGrouping: true }));
  row("grouping false", new Intl.NumberFormat("en-US", { useGrouping: false }));
  for (const useGrouping of ["always", "auto", "min2"] as const) row("grouping " + useGrouping, new Intl.NumberFormat("en-US", { useGrouping }));
  const loose: Intl.NumberFormatOptions = { useGrouping: "true" as "auto" };
  row("grouping \"true\"", new Intl.NumberFormat("en-US", loose));
  row("grouping \"false\"", new Intl.NumberFormat("en-US", { useGrouping: "false" as "auto" }));
  row("compact grouping default", new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 0, maximumSignificantDigits: 21 }));
  for (const signDisplay of ["auto", "never", "always", "exceptZero", "negative"] as const) {
    row("sign " + signDisplay, new Intl.NumberFormat("en-US", { signDisplay }));
    row("sign " + signDisplay + " accounting", new Intl.NumberFormat("en-US", { signDisplay, style: "currency", currency: "USD", currencySign: "accounting" }));
    row("sign " + signDisplay + " percent accounting", new Intl.NumberFormat("en-US", { signDisplay, style: "percent", currencySign: "accounting" }));
  }
  row("numberingSystem latn", new Intl.NumberFormat("en-US", { numberingSystem: "latn" }));
  row("numberingSystem arab", new Intl.NumberFormat("en-US", { numberingSystem: "arab" }));
  row("numberingSystem bogus", new Intl.NumberFormat("en-US", { numberingSystem: "bogus" }));
  row("numberingSystem hanidec", new Intl.NumberFormat("en-US", { numberingSystem: "hanidec" }));
  row("numberingSystem roman", new Intl.NumberFormat("en-US", { numberingSystem: "roman" }));
  row("localeMatcher lookup", new Intl.NumberFormat("en-US", { localeMatcher: "lookup" }));
}

digits();
groupingAndSign();
