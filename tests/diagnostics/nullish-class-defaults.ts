// `??` over class values: an assertion or default that only moves within one
// class hierarchy lowers (corpus nullish-asserted-class-arms); a stored class
// asserted to an unrelated class has no checked view, so the result type
// still differs from the left side's storage and stays rejected.
class Ticket {
  seat = 1;
}
class Voucher {
  seat = 1;
  code = "free";
}
function lookup(): Ticket | undefined {
  return Date.now() < 0 ? new Ticket() : undefined;
}
const pass = (lookup() as Voucher | undefined) ?? new Voucher();
console.log(pass.code);
