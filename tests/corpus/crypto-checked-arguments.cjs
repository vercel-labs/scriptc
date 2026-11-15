// The checked-dynamic crypto entries read their arguments by position and
// ignore the ones after the last they declare, as Node does: checkPrime,
// checkPrimeSync, generatePrime, generatePrimeSync and getCipherInfo
// evaluate a surplus argument for its side effects, then drop it. A
// function in checkPrime's or generatePrime's options position is the
// callback, and the value after it is then the ignored one.
const crypto = require("crypto");

function attempt(label, run) {
  try {
    console.log(label, "ok", run());
  } catch (error) {
    console.log(label, "error", error.name, error.code ?? "-", error.message);
  }
}

const effects = [];
const mark = (label) => {
  effects.push(label);
  return label;
};

attempt("generatePrimeSync surplus", () =>
  crypto.generatePrimeSync(16, {}, mark("generate size")).toString("hex"),
);
console.log("effects", effects.join());
effects.length = 0;
attempt("checkPrimeSync surplus", () => crypto.checkPrimeSync(5n, {}, mark("check candidate")));
console.log("effects", effects.join());
effects.length = 0;
attempt("getCipherInfo surplus", () => crypto.getCipherInfo("aes-128-cbc", { ivLength: 16 }, mark("info name")).name);
console.log("effects", effects.join());
effects.length = 0;

// A surplus argument whose evaluation throws fails the call before Node
// checks the declared arguments.
attempt("surplus throws", () =>
  crypto.checkPrimeSync(null, {}, (() => {
    throw new Error("surplus");
  })()),
);
attempt("surplus throws before bad options", () =>
  crypto.getCipherInfo("aes-128-cbc", { keyLength: "x" }, (() => {
    throw new Error("surplus");
  })()),
);

// checkPrimeSync and generatePrimeSync with values of the wrong shape still
// take Node's checks at run time.
attempt("checkPrimeSync string", () => crypto.checkPrimeSync("5"));
attempt("generatePrimeSync string", () => crypto.generatePrimeSync("16"));
attempt("generatePrimeSync float", () => crypto.generatePrimeSync(16.5));
attempt("getCipherInfo object", () => crypto.getCipherInfo({}));

// A surplus argument whose evaluation answers null or undefined still runs
// for its side effects, and the call completes with the declared answers.
attempt("surplus computed null", () => crypto.checkPrimeSync(5n, {}, (() => null)()));
console.log("effects", effects.join());
effects.length = 0;
attempt("surplus computed undefined", () => crypto.checkPrimeSync(5n, {}, (() => undefined)()));
console.log("effects", effects.join());
effects.length = 0;
attempt("surplus null literal", () => crypto.checkPrimeSync(5n, {}, null));
attempt("surplus void 0", () => crypto.checkPrimeSync(5n, {}, void 0));
attempt("getCipherInfo surplus undefined", () =>
  crypto.getCipherInfo("aes-128-cbc", { ivLength: 16 }, (() => undefined)()).name,
);
console.log("effects", effects.join());
effects.length = 0;
attempt("hash update surplus null", () => crypto.createHash("sha256").update("x", "utf8", (() => null)()).digest("hex"));
attempt("hash update surplus undefined", () =>
  crypto.createHash("sha256").update("x", "utf8", (() => undefined)()).digest("hex"),
);
console.log("effects", effects.join());
effects.length = 0;

let sync = true;
crypto.checkPrime(5n, (error, verdict) => {
  console.log("checkPrime options-as-callback", sync, error, verdict);
  crypto.generatePrime(16, (failure, prime) => {
    console.log("generatePrime options-as-callback", failure, prime instanceof ArrayBuffer, prime.byteLength);
    crypto.checkPrime(5n, { checks: 2 }, (checksError, checksVerdict, extra) => {
      console.log("checkPrime with options", checksError, checksVerdict, extra);
      crypto.generatePrime(16, { bigint: true }, (bigintError, bigintPrime, surplus) => {
        console.log("generatePrime bigint", bigintError, typeof bigintPrime, bigintPrime > 0n, surplus);
        try {
          crypto.checkPrime(4n, "not options", (badError, badVerdict) => {
            console.log("checkPrime bad options callback", badError, badVerdict);
          });
        } catch (badError) {
          console.log("checkPrime bad options", badError.name, badError.code, badError.message);
        }
      }, mark("generate surplus"));
      console.log("effects", effects.join());
      effects.length = 0;
    });
  });
});
console.log("synchronous end", sync);
sync = false;
