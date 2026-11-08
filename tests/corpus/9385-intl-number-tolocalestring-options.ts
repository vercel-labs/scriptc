// @requires-icu
// @env: LC_ALL=en_US.UTF-8,TZ=UTC
// Number.prototype.toLocaleString with a locale and options: the formatter
// `new Intl.NumberFormat(locales, options)` builds, for one call. The
// receiver's value is read before the arguments run.

function toLocaleString(): void {
  const x = 1234567.891;
  const ys = [0, -5.5, 0.125, 1e21];
  console.log(x.toLocaleString(), x.toLocaleString("en-US"), x.toLocaleString("en"), x.toLocaleString(undefined));
  console.log(x.toLocaleString("en-US", { style: "currency", currency: "SEK" }), x.toLocaleString(undefined, { maximumFractionDigits: 1 }));
  console.log(x.toLocaleString("en-US", undefined), x.toLocaleString("en", { notation: "compact" }), x.toLocaleString("en-US", {}));
  console.log(ys.map((y) => y.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })).join(" | "));
  console.log(ys.map((y) => y.toLocaleString(undefined, { style: "percent" })).join(" | "));
  const sizes: Intl.NumberFormatOptions = { style: "unit", unit: "kilobyte", unitDisplay: "long" };
  console.log(x.toLocaleString("en-US", sizes), (5).toLocaleString("en-US", sizes));
  function fmt(n: number, o?: Intl.NumberFormatOptions): string {
    return n.toLocaleString("en-US", o);
  }
  console.log(fmt(1.5), fmt(1.5, { minimumFractionDigits: 3 }), fmt(NaN, { style: "percent" }));
  let n = 10;
  console.log(n.toLocaleString("en-US", { minimumIntegerDigits: (n = 3) }), n);
  console.log((0.5).toLocaleString("en-US", { style: "percent" }), (-0).toLocaleString("en-US", { signDisplay: "always" }));
}

toLocaleString();
