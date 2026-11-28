// Reflecting on an X509Certificate: Node keeps its fields as prototype
// getters, so no own-key walk sees them, JSON.stringify answers the PEM its
// toJSON gives, and prototype members answer `in` and instanceof.
import * as crypto from "node:crypto";

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
-----END CERTIFICATE-----`;

const cert = new crypto.X509Certificate(PEM);
console.log("keys", JSON.stringify(Object.keys(cert)));
console.log("ownNames", JSON.stringify(Object.getOwnPropertyNames(cert)));
console.log("entries", JSON.stringify(Object.entries(cert)));
console.log(
  "own",
  Object.hasOwn(cert, "subject"),
  Object.hasOwn(cert, "nope"),
  cert.hasOwnProperty("subject"),
  cert.hasOwnProperty("toJSON"),
);
console.log(
  "in",
  "subject" in cert,
  "issuerCertificate" in cert,
  "checkHost" in cert,
  "hasOwnProperty" in cert,
  "nope" in cert,
);
const json = JSON.stringify(cert);
console.log("json", typeof json, json.slice(0, 28), json.length);
console.log("instanceof", cert instanceof crypto.X509Certificate);

// A certificate read that is absent at run time — a missing lookup entry the
// checker typed as a certificate — answers false to the class test, as Node
// does (its own-key walks over such a value are refused at compile time).
const certificates: Record<string, crypto.X509Certificate> = {};
console.log(
  "missing lookup",
  certificates["missing"] instanceof crypto.X509Certificate,
  cert instanceof crypto.X509Certificate,
);
console.log("toString", typeof cert.toString(), String(cert).split("\n")[0], String(cert).length);
