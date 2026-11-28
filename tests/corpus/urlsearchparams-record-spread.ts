// A URLSearchParams init that spreads a closed record appends the spread's
// entries where the literal put them, in the merged object's key order, and
// the spread source evaluates once at its position.
function token(options: { device_code: string }): string {
  return new URLSearchParams({
    client_id: "cid",
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    ...options,
  }).toString();
}
console.log(token({ device_code: "d-1" }));

let log = "";
function source(): { b: string } {
  log += "s";
  return { b: "2" };
}
const params = new URLSearchParams({
  a: `${((log += "a"), "1")}`,
  ...source(),
  c: `${((log += "c"), "3")}`,
  0: "zero",
});
console.log(params.toString());
console.log(log);
