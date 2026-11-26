// A certificate reflection call evaluates every argument, in order, as
// Node's call does: the walk reads only the first, and the others' side
// effects still happen. The extra arguments are a TypeScript arity error
// this file expects and suppresses (Node's own calls take them).
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
const seen: string[] = [];
const effect = (label: string): string => {
  seen.push(label);
  return label;
};
// @ts-expect-error — the walk takes one argument; Node evaluates the rest.
console.log("hasOwnProperty", cert.hasOwnProperty(effect("a"), effect("b")), seen.join(","));
seen.length = 0;
// @ts-expect-error — the walk takes one argument; Node evaluates the rest.
console.log("propertyIsEnumerable", cert.propertyIsEnumerable(effect("c"), effect("d")), seen.join(","));
seen.length = 0;
// The receiver is evaluated once, whether the probe is a plain call or the
// borrowed Object.prototype form.
let lookups = 0;
const getCert = (): crypto.X509Certificate => {
  lookups++;
  return cert;
};
console.log("borrowed", Object.prototype.hasOwnProperty.call(getCert(), "subject"), lookups);
lookups = 0;
console.log("own method", getCert().hasOwnProperty("subject"), lookups);
// A validation call inside the reflected expression always runs: the walk
// evaluates its receiver (here a counting lookup) before it answers.
let inspections = 0;
const inspected = (): crypto.X509Certificate => {
  inspections++;
  return cert;
};
console.log("keys receiver", JSON.stringify(Object.keys(inspected())), inspections);
inspections = 0;
console.log("names receiver", JSON.stringify(Object.getOwnPropertyNames(inspected())), inspections);
inspections = 0;
console.log("entries receiver", JSON.stringify(Object.entries(inspected())), inspections);
console.log("toString", String(cert).split("\n")[0]);
