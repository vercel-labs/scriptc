// @requires-icu
// @env: LC_ALL=en_US.UTF-8,TZ=UTC
// Intl formatters in JavaScript: the options object is read through
// whatever it is (a Proxy sees the reads in ECMA-402's order; getters,
// valueOf and toString run; a getter's error propagates), and format() takes
// the value it is given.

{
  const nf = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
  console.log(nf.format(1234.5), dtf.format(new Date(0)), dtf.format(1e12));
  function show(formatter, value) {
    return formatter.format(value);
  }
  console.log(show(nf, 0.5), show(dtf, 86400000));
  console.log((1234.5).toLocaleString("en-US", { minimumFractionDigits: 2 }), new Date(0).toLocaleDateString("en-US", { timeZone: "UTC", month: "long" }));
  const options = { notation: "compact" };
  options.compactDisplay = "long";
  console.log(new Intl.NumberFormat("en-US", options).format(1234567));
  try {
    new Intl.NumberFormat("en-US", { style: "nope" });
  } catch (e) {
    console.log(e.name, e.message);
  }
  const zoned = (timeZone) => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric" }).format(0);
    } catch (e) {
      return e.name + ": " + e.message;
    }
  };
  console.log(zoned(5), "|", zoned(null), "|", zoned(true), "|", zoned("UTC"), "|", zoned(undefined) === new Intl.DateTimeFormat("en-US", { hour: "numeric" }).format(0));
  console.log(dtf.format(), typeof dtf.format(undefined), dtf.format(null), dtf.format(true), nf.format(), nf.format(undefined));
}

{
  const reads = [];
  const watch = (target) => new Proxy(target, { get(t, k) { reads.push(String(k)); return t[k]; } });
  console.log(new Intl.NumberFormat("en-US", watch({ style: "percent" })).format(0.5));
  console.log(reads.join(","));
  reads.length = 0;
  console.log(new Intl.DateTimeFormat("en-US", watch({ timeZone: "UTC", year: "numeric" })).format(0));
  console.log(reads.join(","));
  reads.length = 0;
  console.log(new Date(0).toLocaleTimeString("en-US", watch({ timeZone: "UTC" })));
  console.log(reads.join(","));
  reads.length = 0;
  const getters = { get style() { reads.push("style"); return "currency"; }, get currency() { reads.push("currency"); return "EUR"; }, get notation() { reads.push("notation"); return undefined; } };
  console.log(new Intl.NumberFormat("en-US", getters).format(2), reads.join(","));
  const throwing = { get style() { throw new Error("from the getter"); } };
  try {
    new Intl.NumberFormat("en-US", throwing);
  } catch (e) {
    console.log(e.message);
  }
  const conversions = { maximumFractionDigits: { valueOf() { reads.push("valueOf"); return 1; } }, style: { toString() { reads.push("toString"); return "decimal"; } } };
  reads.length = 0;
  console.log(new Intl.NumberFormat("en-US", conversions).format(1.26), reads.join(","));
}
