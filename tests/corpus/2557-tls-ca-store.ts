// The CA-store introspection surface (scr_tls_ca.c): getCACertificates'
// per-type cached arrays (identity-stable, Node's caching), the
// rootCertificates read, and setDefaultCACertificates' live replacement
// with Node's dedupe and error shapes. The host bundle stands in for
// Node's Mozilla roots, so every print is a PREDICATE (shape, identity,
// lengths relative to each other) — never absolute store contents.
import * as tls from "node:tls";
import { getCACertificates, rootCertificates } from "node:tls";

function looksPem(s: string): boolean {
  const t = s.trim();
  return t.startsWith("-----BEGIN CERTIFICATE-----") && t.endsWith("-----END CERTIFICATE-----");
}

const bundled = getCACertificates("bundled");
console.log("bundled-nonempty", bundled.length > 0);
let allPem = true;
for (const cert of bundled) {
  if (!looksPem(cert)) {
    allPem = false;
  }
}
console.log("bundled-pem", allPem);

// Identity: cached per type, and rootCertificates IS the bundled store.
console.log("cached", getCACertificates("bundled") === bundled);
console.log("roots", rootCertificates === bundled, tls.rootCertificates === bundled);
console.log("default-cached", getCACertificates() === getCACertificates("default"));
const system = getCACertificates("system");
console.log("system-cached", system === getCACertificates("system"));
console.log("extra-cached", getCACertificates("extra") === getCACertificates("extra"));

// Windows is the store-backed implementation this case needs to pin. Other
// hosts may legitimately expose an empty/inaccessible system store, and
// scriptc's documented POSIX bundle source need not share that cardinality.
if (process.platform === "win32") {
  console.log("system-nonempty", system.length > 0);
  tls.setDefaultCACertificates(system);
  console.log("system-default", getCACertificates("default").length > 0);
}

// A fixed self-signed certificate (only its identity matters here).
const PEM = `-----BEGIN CERTIFICATE-----
MIIDEzCCAfugAwIBAgIUMsBCFtPck8TATMJzfikgW963q3AwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNdHNuYXRpdmUtdGVzdDAgFw0yNjA3MTcxNzUyMTFaGA8y
MTI2MDYyMzE3NTIxMVowGDEWMBQGA1UEAwwNdHNuYXRpdmUtdGVzdDCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBALRspe2XjtKvNU7Ws5JfqzmTCPmWtfw0
1Uha271hNp/30VstOxWLbpqPrXDvIwJMN4o8CRp92Y1hcmS36m9QS5qfXJFw+n+S
SWGpFdMNvp6hro0OoNBA+anuKWoTsMyHSwe8ND0fyobQbgAXJ0+snmuK0E2ii+CM
IoUqYbK57nHeyHfISLupgrRoNGXjDHv4v+RSr3MJDag6BLA+/yVjkBOBOT6kaE4K
oyNXYYsfFxGnB/4pDSanV/UsfJ4wHXkVn18ndZHIzTsZMUkV4BecF8UaMrP+u8NI
c5wce0uWLFFEneK4q15iVvk9TaY0g1Uj69ryRT3L58W7RYYuHu7cVB0CAwEAAaNT
MFEwHQYDVR0OBBYEFLT2GqaTmxDhntPxMWaUZvA3s9V5MB8GA1UdIwQYMBaAFLT2
GqaTmxDhntPxMWaUZvA3s9V5MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEL
BQADggEBAFcTLVJIyhbIKHfOnGM5T+Kzu5IoDlqzr+Rdx/0IKFLVDqEA9ihEme07
K/d246pOW5LBceVDY2eMikDpIOjYPEoe9C+Ftv5zrCaDw1wtXrq8a7/eS5B+3TzL
k8c1SVVDPIbmViAZNRmnkwCPBsIF9xIfMFhxz4BTJrm/Lt2Hv1GcRBQx/yRK89sj
JiGnsTna//4mPGRGYw+dRCq4tbyr8HbBKdJmbzOCb4CPKfwAMKUpd4e0Ao7jh/BU
EML7B3BEzv5Jw/BT7B39wAfDyhq32PnRnZefF+7pAmpkklHbckBtZtWn02zwQazv
5z62tszZee2i4BouJiyFnb30F6Pebs4=
-----END CERTIFICATE-----
`;

// Replacement is live and observable: the exact string round-trips.
tls.setDefaultCACertificates([PEM]);
const replaced = getCACertificates("default");
console.log("replaced", replaced.length, replaced[0] === PEM);
// Other types stay untouched.
console.log("bundled-untouched", getCACertificates("bundled") === bundled);

// Duplicates collapse (Node dedupes the set).
tls.setDefaultCACertificates([PEM, PEM, PEM]);
console.log("dedup", getCACertificates("default").length);

// The empty set is a valid set: trust nothing.
tls.setDefaultCACertificates([]);
console.log("emptied", getCACertificates("default").length);

// Restoring from the bundled store round-trips the count.
tls.setDefaultCACertificates(bundled);
console.log("restored", getCACertificates("default").length === bundled.length);

// An unknown type: Node's ERR_INVALID_ARG_VALUE TypeError, catchable.
try {
  getCACertificates("bogus");
  console.log("no-throw");
} catch (e) {
  if (e instanceof TypeError) {
    console.log("bad-type", e.message);
  } else {
    console.log("not-a-typeerror");
  }
}

// A non-empty array with no certificate blocks: Node's
// ERR_CRYPTO_OPERATION_FAILED, and the current set stays intact.
try {
  tls.setDefaultCACertificates(["not a pem at all"]);
  console.log("no-throw");
} catch (e) {
  if (e instanceof Error) {
    console.log("bad-set", e.message);
  }
}
console.log("intact", getCACertificates("default").length === bundled.length);
