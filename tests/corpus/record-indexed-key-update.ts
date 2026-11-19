// An index-signature record updated through a computed key whose storage can
// hold a hidden undefined (an unchecked element read). JavaScript's
// ToPropertyKey names the property "undefined" for that key, so the update
// and the read agree with Node instead of refusing the key.
type Status = "ok" | "fail" | "skip";

function tally(keys: string[]): Record<string, number> {
  const counts: Record<Status, number> = { ok: 1, fail: 2, skip: 3 };
  const total: Record<string, number> = {};
  for (const k of Object.keys(counts) as Status[]) {
    total[k] += counts[k];
  }
  for (let i = 0; i <= keys.length; i++) {
    const key = keys[i];
    total[key] += 1;
  }
  return total;
}

const counted = tally(["ok", "extra"]);
console.log(JSON.stringify(counted));
console.log(Object.keys(counted).sort().join(","));
