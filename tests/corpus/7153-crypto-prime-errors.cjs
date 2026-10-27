// checkPrime, checkPrimeSync, generatePrime and generatePrimeSync errors from
// JavaScript: argument types and ranges, the options bag, add and rem, and
// OpenSSL's generation failures, synchronously and through the callbacks.
const crypto = require("crypto");

function attempt(label, run) {
  try {
    const value = run();
    console.log(label, "ok", typeof value === "bigint" ? `${value}n` : value instanceof ArrayBuffer ? `ArrayBuffer(${value.byteLength})` : value);
  } catch (e) {
    console.log(label, e.name, e.code, e.message, JSON.stringify(Object.keys(e)));
  }
}

attempt("check string", () => crypto.checkPrimeSync("7"));
attempt("check number", () => crypto.checkPrimeSync(7));
attempt("check negative", () => crypto.checkPrimeSync(-7n));
attempt("check large negative", () => crypto.checkPrimeSync(-(2n ** 40n)));
attempt("check options null", () => crypto.checkPrimeSync(7n, null));
attempt("check options array", () => crypto.checkPrimeSync(7n, []));
attempt("check options string", () => crypto.checkPrimeSync(7n, "x"));
attempt("check checks string", () => crypto.checkPrimeSync(7n, { checks: "1" }));
attempt("check checks fraction", () => crypto.checkPrimeSync(7n, { checks: 1.5 }));
attempt("check checks -1", () => crypto.checkPrimeSync(7n, { checks: -1 }));
attempt("check checks 2^31", () => crypto.checkPrimeSync(7n, { checks: 2 ** 31 }));
attempt("check checks -0", () => crypto.checkPrimeSync(7n, { checks: -0 }));
attempt("check checks 10", () => crypto.checkPrimeSync(7n, { checks: 10 }));
attempt("check no callback", () => crypto.checkPrime(7n));
attempt("check callback string", () => crypto.checkPrime(7n, {}, "cb"));
attempt("check async string", () => crypto.checkPrime("7", () => {}));
attempt("check async options null", () => crypto.checkPrime(7n, null, () => {}));

attempt("size string", () => crypto.generatePrimeSync("8"));
attempt("size fraction", () => crypto.generatePrimeSync(8.5));
attempt("size 0", () => crypto.generatePrimeSync(0));
attempt("size 2^31", () => crypto.generatePrimeSync(2 ** 31));
attempt("size NaN", () => crypto.generatePrimeSync(NaN));
attempt("size 1", () => crypto.generatePrimeSync(1));
attempt("size 2 safe", () => crypto.generatePrimeSync(2, { safe: true }));
attempt("size 4 safe", () => crypto.generatePrimeSync(4, { safe: true }));
attempt("size 5 safe", () => crypto.generatePrimeSync(5, { safe: true }));
attempt("options null", () => crypto.generatePrimeSync(8, null));
attempt("options number", () => crypto.generatePrimeSync(8, 1));
attempt("safe string", () => crypto.generatePrimeSync(8, { safe: "yes" }));
attempt("bigint number", () => crypto.generatePrimeSync(8, { bigint: 1 }));
attempt("add number", () => crypto.generatePrimeSync(8, { add: 6 }));
attempt("add string", () => crypto.generatePrimeSync(8, { add: "6" }));
attempt("add negative", () => crypto.generatePrimeSync(8, { add: -6n }));
attempt("rem number", () => crypto.generatePrimeSync(8, { add: 6n, rem: 1 }));
attempt("rem negative", () => crypto.generatePrimeSync(8, { add: 6n, rem: -1n }));
attempt("add too long", () => crypto.generatePrimeSync(8, { add: 1024n }));
attempt("add zero", () => crypto.generatePrimeSync(8, { add: 0n }));
attempt("add zero bytes", () => crypto.generatePrimeSync(8, { add: new Uint8Array(0) }));
attempt("rem equal add", () => crypto.generatePrimeSync(8, { add: 6n, rem: 6n }));
attempt("rem above add", () => crypto.generatePrimeSync(8, { add: 6n, rem: 7n }));
attempt("rem without add", () => crypto.generatePrimeSync(8, { rem: 1000n, bigint: true }) < 256n);
attempt("add 1 bigint", () => crypto.generatePrimeSync(8, { add: 1n, bigint: true }) < 256n);
attempt("gen no callback", () => crypto.generatePrime(8));
attempt("gen options callback", () => crypto.generatePrime(8, {}));
attempt("gen size string", () => crypto.generatePrime("8", () => {}));
attempt("gen add too long", () => crypto.generatePrime(8, { add: 1024n }, () => {}));
attempt("gen options null", () => crypto.generatePrime(8, null, () => {}));

// The callback forms' generation errors and results, one after another.
crypto.generatePrime(1, function (err, prime) {
  console.log("gen 1 callback", arguments.length, err.name, err.code, err.message, JSON.stringify(Object.keys(err)), prime);
  crypto.generatePrime(8, { add: 0n }, function (err2, prime2) {
    console.log("gen add 0 callback", arguments.length, err2.message, prime2);
    crypto.generatePrime(3, { safe: true, bigint: true }, function (err3, prime3) {
      console.log("gen 3 safe callback", arguments.length, err3, prime3);
      crypto.checkPrime(7n, function (err4, result) {
        console.log("check 7 callback", arguments.length, err4, result);
        crypto.checkPrime(new Uint8Array([0, 0, 9]), { checks: 3 }, function (err5, result2) {
          console.log("check 9 callback", arguments.length, err5, result2);
        });
      });
    });
  });
});
console.log("sync end");
