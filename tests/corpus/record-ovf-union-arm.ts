// A record arm with an index signature narrowing into another
// index-signature record arm of a union.
//
// The union conversion re-tags the record arm by the overflow CAPTURE
// reshape: the shared declared fields copy off the source and every other
// source field keys into the destination's overflow. Node erases the types
// and keeps one object, so reads of the shared fields, of the extra
// declared field (`type`) and of the overflow entries answer the same
// values in the same key order.
interface Credentials {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

interface Tagged extends Credentials {
  type: "oauth";
}

interface ApiKey {
  type: "api_key";
  key?: string;
}

type Credential = ApiKey | Tagged;

function oauthOf(credential: Credential | undefined): Credentials | undefined {
  return credential?.type === "oauth" ? credential : undefined;
}

const stored: Credential[] = [
  // Literal keys in declaration order: the reshape writes the source's
  // declared fields in that order, then its overflow.
  { refresh: "r1", access: "a1", expires: 100, type: "oauth", account: "acct", scope: 3 },
  { type: "api_key", key: "k1" },
  { refresh: "r2", access: "a2", expires: 200, type: "oauth" },
];

for (const credential of stored) {
  const kept = oauthOf(credential);
  if (kept === undefined) {
    console.log(String(credential.type), "none");
    continue;
  }
  console.log(Object.keys(kept).join(","));
  console.log(String(kept.type), kept.refresh, kept.access, kept.expires);
  console.log(String(kept.account), String(kept.scope));
}

// The undefined arm keeps its tag through the same conversion.
const missing = oauthOf(undefined);
console.log(missing === undefined);

// The directly assigned wide record (the top-level path the union arm now
// shares) answers the same reads, and a write keys into the copy's own
// overflow.
const tagged: Tagged = { refresh: "r3", access: "a3", expires: 300, type: "oauth", region: "eu" };
const direct: Credentials = tagged;
console.log(Object.keys(direct).join(","), String(direct.type), String(direct.region));
direct.region = "us";
console.log(String(direct.region));
