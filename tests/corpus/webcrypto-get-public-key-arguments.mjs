// crypto.subtle.getPublicKey's argument count and argument types, called without the optional-argument casts a TypeScript program needs, so the count and sequence errors come from the method.
// @normalize-pid
const ecdsa = await crypto.subtle.importKey(
  "jwk",
  {
    kty: "EC",
    crv: "P-256",
    x: "EOqDlhcTYVchChRDUHhnn_qDeDaLUbUdyrTTwImASTM",
    y: "evKit-VCLHUMj9s9NRX8dPOgweWQlm-35U0ACQajuzY",
    d: "iK8e568E3TXpqdE29i-ibynUFtoA6Yj1cQ4oKqqFaDU",
  },
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign"],
);
for (const [label, run] of [
  ["no arguments", () => crypto.subtle.getPublicKey()],
  ["one argument", () => crypto.subtle.getPublicKey(ecdsa)],
  ["usages not a sequence", () => crypto.subtle.getPublicKey(ecdsa, "verify")],
  ["bad usage name", () => crypto.subtle.getPublicKey(ecdsa, ["nope"])],
]) {
  const result = await run().then(() => "resolved", (error) => `${error.name} ${error.message}`);
  console.log(label, result);
}
