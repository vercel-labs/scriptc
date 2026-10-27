// `new` of a builtin class bound through a member of a require() result
// (`const SD = require("string_decoder").StringDecoder`, the spelling of
// Node's own tests): the binding resolves to the class, as the
// destructured `const { StringDecoder } = require(...)` does, also for the
// X509Certificate record.
"use strict";
const SD = require("string_decoder").StringDecoder;
const Readable = require("stream").Readable;
const PassThrough = require("stream").PassThrough;
const Transform = require("stream").Transform;
const X509 = require("crypto").X509Certificate;

const decoder = new SD("utf8");
console.log(decoder.encoding);
console.log(JSON.stringify(decoder.write(Buffer.from([0xe2, 0x82]))));
console.log(decoder.end(Buffer.from([0xac])));
const hex = new SD("hex");
console.log(hex.encoding, hex.write(Buffer.from("hi")));
console.log(new SD().encoding);

const r = new Readable({ read() {} });
r.on("data", (chunk) => console.log("readable", String(chunk)));
r.on("end", () => console.log("readable end"));
r.push("abc");
r.push(null);

const p = new PassThrough();
p.on("data", (chunk) => console.log("passthrough", String(chunk)));
p.end("xyz");

const upper = new Transform({
  transform(chunk, encoding, callback) {
    callback(null, String(chunk).toUpperCase());
  },
});
upper.on("data", (chunk) => console.log("transform", String(chunk)));
upper.end("shout");

// The X509Certificate record constructs through the same binding.
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
const cert = new X509(PEM);
console.log(cert.fingerprint, cert.validFrom, cert.validTo);
