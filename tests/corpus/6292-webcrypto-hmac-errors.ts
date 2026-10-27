// WebCrypto HMAC failures reject with Node's TypeErrors (argument count,
// enum values, buffer sources, CryptoKey arguments, required members) and
// DOMExceptions (usages, key length, algorithm names, key access).
const encoder = new TextEncoder();
const secret = encoder.encode("scriptc-webcrypto-secret");
const data = encoder.encode("payload");

function report(label: string, error: Error): void {
  if (error instanceof DOMException) {
    const dom = error as DOMException;
    console.log(label, dom.name, dom.code, dom.message, "DOMException");
  } else {
    const coded = error as Error & { code?: string };
    console.log(label, coded.name, coded.code, coded.message);
  }
}

async function attempt(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    console.log(label, "resolved");
  } catch (e) {
    report(label, e as Error);
  }
}

async function attemptVerify(label: string, run: () => Promise<boolean>): Promise<void> {
  try {
    console.log(label, "resolved", await run());
  } catch (e) {
    report(label, e as Error);
  }
}

const signOnly = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const verifyOnly = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-384" }, false, ["verify"]);

await attempt("usage", () =>
  crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "encrypt"]),
);
await attempt("empty usages", () =>
  crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, []),
);
await attempt("zero-length key", () =>
  crypto.subtle.importKey("raw", new Uint8Array(0), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
);
await attempt("length mismatch", () =>
  crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256", length: 64 }, false, ["sign"]),
);
await attempt("length zero", () =>
  crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256", length: 0 }, false, ["sign"]),
);
await attempt("missing hash", () =>
  crypto.subtle.importKey("raw", secret, "HMAC", false, ["sign"]),
);
await attempt("md5 hash", () =>
  crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "MD5" }, false, ["sign"]),
);
await attempt("unknown sha", () =>
  crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-999" }, false, ["sign"]),
);
await attempt("unknown algorithm", () =>
  crypto.subtle.importKey("raw", secret, { name: "NOPE", hash: "SHA-256" }, false, ["sign"]),
);
await attempt("pkcs8 format", () =>
  crypto.subtle.importKey("pkcs8", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
);
await attempt("string key", () =>
  crypto.subtle.importKey("raw", "secret" as unknown as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
);

await attempt("sign with verify key", () => crypto.subtle.sign("HMAC", verifyOnly, data));
await attemptVerify("verify with sign key", () => crypto.subtle.verify("HMAC", signOnly, new Uint8Array(32), data));
await attempt("sign without key", () =>
  crypto.subtle.sign("HMAC", secret as unknown as CryptoKey, data),
);
await attempt("sign unknown algorithm", () => crypto.subtle.sign("HMAC-SHA256", signOnly, data));
await attempt("sign string data", () =>
  crypto.subtle.sign("HMAC", signOnly, "payload" as unknown as BufferSource),
);
await attemptVerify("verify string signature", () =>
  crypto.subtle.verify("HMAC", verifyOnly, "sig" as unknown as BufferSource, data),
);
