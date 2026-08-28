// Date.UTC — a pure function of its numbers: the spec's MakeDay/MakeTime/
// TimeClip pipeline (0–99 years map to 1900+year, out-of-range months and
// dates roll over, ToInteger truncation, NaN for non-finite parts and
// out-of-range results, V8's ±1e6 MakeDay year bound). Node is the oracle.

console.log(Date.UTC(2017));
console.log(Date.UTC(2017, 13), Date.UTC(96, 1, 2, 3, 4, 5, 6), Date.UTC(2017, 0, 60), Date.UTC(2000, -3), Date.UTC(0 / 0), Date.UTC(275760, 8, 13), Date.UTC(275760, 8, 14), Date.UTC(-1, 0, 1, 0, 0, 0, -1));
console.log(Date.UTC(1000000, 0), Date.UTC(-271821, 3, 20), Date.UTC(-271821, 3, 19), Date.UTC(99, 0), Date.UTC(100, 0), Date.UTC(-1, 0), Date.UTC(2016, 1, 29), Date.UTC(1900, 1, 29), Date.UTC(2000, 1, 29));
console.log(Date.UTC(2017, 0, 1, 23, 59, 59, 999), Date.UTC(2017, 0, 1, 24, 0, 0, 0), Date.UTC(2017, 0, 0), Date.UTC(2017, -1, 31), Date.UTC(2017.9, 0.9, 1.9, 0.9, 0.9, 0.9, 0.9));
console.log(Date.UTC(1970), Date.UTC(1970, 0, 1, 0, 0, 0, 1), Date.UTC(1969, 11, 31, 23, 59, 59, 999));
console.log(Date.UTC(2 ** 31, 0), Date.UTC(-(2 ** 31), 0), Date.UTC(1e6 + 1, 0), Date.UTC(2017, 1e21));
// V8 applies its MakeDay bounds to the individual year/month inputs before
// month normalization. These pairs straddle both limits while normalization
// would otherwise leave a TimeClip-valid result.
console.log(Date.UTC(-833333, 10000000), Date.UTC(-833333, 10000001), Date.UTC(833334, -10000000), Date.UTC(833334, -10000001));
console.log(Date.UTC(1000000, -8700000), Date.UTC(1000001, -8700000), Date.UTC(-1000000, 8748000), Date.UTC(-1000001, 8748000));
