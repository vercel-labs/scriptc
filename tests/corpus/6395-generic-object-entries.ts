// Object.entries over a generic record parameter.
function maskSecrets<T extends Record<string, unknown>>(tags: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(tags).map(([k, v]) => [k, k.includes("secret") ? "[redacted]" : v]),
  );
}
console.log(JSON.stringify(maskSecrets({ user: "ada", secretToken: "x", n: 1 })));
