// RSA key generation parameters: publicExponent's validateUint32 checks
// and its 65537 default, and the errors OpenSSL reports for modulus
// lengths and exponents it does not generate, in OpenSSL's order.
// generateKeyPairSync throws those errors and generateKeyPair passes them
// to its callback, alone, in a later macrotask.
import * as crypto from "node:crypto";

type RsaOptions = { modulusLength: number; publicExponent?: unknown };

function attempt(label: string, options: RsaOptions): void {
  try {
    const { publicKey } = crypto.generateKeyPairSync("rsa", options as crypto.RSAKeyPairKeyObjectOptions);
    const details = publicKey.asymmetricKeyDetails!;
    console.log(label, details.modulusLength, details.publicExponent);
  } catch (e) {
    const error = e as NodeJS.ErrnoException;
    console.log(label, "throws", error.name, error.code, error.message);
  }
}

attempt("exponent 1.5", { modulusLength: 1024, publicExponent: 1.5 });
attempt("exponent NaN", { modulusLength: 1024, publicExponent: NaN });
attempt("exponent Infinity", { modulusLength: 1024, publicExponent: Infinity });
attempt("exponent -1", { modulusLength: 1024, publicExponent: -1 });
attempt("exponent 2 ** 32", { modulusLength: 1024, publicExponent: 2 ** 32 });
attempt("exponent string", { modulusLength: 1024, publicExponent: "3" });
attempt("exponent bigint", { modulusLength: 1024, publicExponent: 3n });
attempt("exponent null", { modulusLength: 1024, publicExponent: null });
attempt("exponent undefined", { modulusLength: 1024, publicExponent: undefined });
attempt("exponent 3", { modulusLength: 1024, publicExponent: 3 });
attempt("exponent 17", { modulusLength: 1024, publicExponent: 17 });
attempt("exponent 0", { modulusLength: 1024, publicExponent: 0 });
attempt("exponent -0", { modulusLength: 1024, publicExponent: -0 });
attempt("exponent 1", { modulusLength: 1024, publicExponent: 1 });
attempt("exponent 2", { modulusLength: 1024, publicExponent: 2 });
attempt("exponent 4", { modulusLength: 1024, publicExponent: 4 });
attempt("exponent 2 ** 31", { modulusLength: 1024, publicExponent: 2 ** 31 });
attempt("modulusLength 0", { modulusLength: 0 });
attempt("modulusLength -0", { modulusLength: -0 });
attempt("modulusLength 100", { modulusLength: 100 });
attempt("modulusLength 511", { modulusLength: 511 });
attempt("modulusLength 2 ** 31", { modulusLength: 2 ** 31 });
attempt("modulusLength 2 ** 32 - 1", { modulusLength: 2 ** 32 - 1 });
attempt("modulusLength 100, exponent 4", { modulusLength: 100, publicExponent: 4 });
attempt("modulusLength 100, exponent 0", { modulusLength: 100, publicExponent: 0 });
attempt("modulusLength 2 ** 31, exponent 0", { modulusLength: 2 ** 31, publicExponent: 0 });
attempt("modulusLength 2 ** 31, exponent 4", { modulusLength: 2 ** 31, publicExponent: 4 });

function later(label: string, options: RsaOptions, next: () => void): void {
  try {
    crypto.generateKeyPair("rsa", options as crypto.RSAKeyPairKeyObjectOptions, (...args: unknown[]) => {
      const error = args[0] as Error | null;
      console.log(label, "callback", args.length, error === null ? null : [error.name, error.message]);
      next();
    });
    console.log(label, "returned");
  } catch (e) {
    console.log(label, "throws", (e as Error).message);
    next();
  }
}

later("async exponent 4", { modulusLength: 1024, publicExponent: 4 }, () =>
  later("async modulusLength 100", { modulusLength: 100 }, () =>
    later("async exponent 0", { modulusLength: 1024, publicExponent: 0 }, () =>
      later("async exponent 1.5", { modulusLength: 1024, publicExponent: 1.5 }, () =>
        later("async exponent 3", { modulusLength: 1024, publicExponent: 3 }, () => console.log("done")),
      ),
    ),
  ),
);
process.nextTick(() => console.log("tick"));
