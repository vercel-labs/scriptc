// jose 6.2.12's error classes (dist/webapi/util/errors.js), verbatim in
// shape: minifiers join a derived constructor's statements into one comma
// expression that opens with super(...). Each comma operand runs as its
// own statement, so the base constructor and the class field initializers
// finish before the trailing assignments.
class JOSEError extends Error {
  static code = "ERR_JOSE_GENERIC";
  code = "ERR_JOSE_GENERIC";
  constructor(message, options) {
    super(message, options), this.name = this.constructor.name, Error.captureStackTrace?.(this, this.constructor);
  }
}
class JWTClaimValidationFailed extends JOSEError {
  static code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
  code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
  claim;
  reason;
  payload;
  constructor(message, payload, claim = "unspecified", reason = "unspecified") {
    super(message, { cause: { claim, reason, payload } }), this.claim = claim, this.reason = reason, this.payload = payload;
  }
}
class JWTExpired extends JOSEError {
  static code = "ERR_JWT_EXPIRED";
  code = "ERR_JWT_EXPIRED";
  claim;
  reason;
  payload;
  constructor(message, payload, claim = "unspecified", reason = "unspecified") {
    super(message, { cause: { claim, reason, payload } }), this.claim = claim, this.reason = reason, this.payload = payload;
  }
}
class JOSEAlgNotAllowed extends JOSEError {
  static code = "ERR_JOSE_ALG_NOT_ALLOWED";
  code = "ERR_JOSE_ALG_NOT_ALLOWED";
}
class JWSSignatureVerificationFailed extends JOSEError {
  static code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  constructor(message = "signature verification failed", options) {
    super(message, options);
  }
}

// The stack is read where the receiver's class is known: a read through an
// untyped parameter does not see the stack (a documented scriptc gap).
function describe(label, error, stack) {
  console.log(label, error.name, error.code, JSON.stringify(error.message));
  console.log("  instanceof", error instanceof JOSEError, error instanceof Error);
  console.log("  stack head", String(stack).split("\n")[0]);
}

const generic = new JOSEError("generic failure");
describe("generic", generic, generic.stack);
console.log("  static", JOSEError.code, "cause" in generic);

const withCause = new JOSEError("wrapped", { cause: "root" });
describe("wrapped", withCause, withCause.stack);
console.log("  cause", withCause.cause);

const claims = { sub: "user", exp: 1 };
const failed = new JWTClaimValidationFailed('"iss" claim mismatch', claims, "iss", "check_failed");
describe("claim", failed, failed.stack);
console.log("  fields", failed.claim, failed.reason, failed.payload === claims);
console.log("  cause", failed.cause.claim, failed.cause.reason, failed.cause.payload === claims);
console.log("  chain", failed instanceof JWTClaimValidationFailed, failed instanceof JWTExpired);

const defaults = new JWTClaimValidationFailed("defaults", claims);
console.log("defaults", defaults.claim, defaults.reason);

const expired = new JWTExpired('"exp" claim timestamp check failed', claims, "exp");
describe("expired", expired, expired.stack);
console.log("  static", JWTExpired.code, expired.reason);

const alg = new JOSEAlgNotAllowed('"alg" (Algorithm) Header Parameter value not allowed');
describe("alg", alg, alg.stack);
const sig = new JWSSignatureVerificationFailed();
describe("sig", sig, sig.stack);

try {
  throw new JWTExpired("thrown", claims, "exp", "check_failed");
} catch (error) {
  if (error instanceof JOSEError) console.log("caught", error.name, error.code, error.claim);
}
