// pipe() into a Sign or Verify: the source's chunks go through write(),
// the end of the source ends the stream, and finish and close follow, so
// the signature is ready in the finish handler.
import * as crypto from "node:crypto";
import { Readable } from "node:stream";

const RSA = `-----BEGIN RSA PRIVATE KEY-----
MIICWwIBAAKBgQDWei4BREJm+4C6u/+F4NI7kTOQ9gf/a+Ecd2SZxfpXRtXT0QVN
MAI1uQNmB4abYzvd1G2V2XKsTJFJcJWibjAz56UxtxxggTpSAalFZYoPm6HfabwJ
b/YWh0K0OrNFvdkeXLLMiHQsxmIQ2lrFoycQEpZ4/yxjLe6LQF+L79k2ywIDAQAB
AoGAMWS/9ZC3zim7ssWbCkUFhaxh+M+AdgVtOXYRmAxtI+5vTjHEC8uzppWuP7Aa
Au0um17RwgHrE90qVIR2IYtI1C9K9RLUNlKKVPqnSSmr0qkXR246R/Zd8eho1XSS
MX6KmnbmRijUx9Rw1AbD2ZmYCrXsPf2HsCdH+SGQ1ZTunnECQQD090dTA21Jyu/b
ADglqgixJCPIoc6qpxst+W1LreIo4UvkSmgnRYvsKDlM7FNI+6f7igI625KXIAnl
xVlmGLXDAkEA4CNVeP07fmQUBs1aPQ9LCOvN42SV6S8Fjbf4XHIYG5Kp48/98oJj
1pFsXNa8nn8fmN9zFw8yM/yd22iZdueCWQJAWMja//po/OrhniVpNDV5awKnOYtz
xSRF1JbnhxthseFeSUKylzE8sn4trnSlBvm2+5MclcqJSd7h13Z8nWVtUwJAZ0SA
Ve0+ov4TKAsnH2jTZnnWc4VdeIFcqq3vdRBwQQvy0G59D2W6ABsidSfO4auqcDHL
gf1TYRZr2LI5usnxiQJAGt3e0QC0q0WN4p49YhyXXVuHccx79RFgfN7V1lkAyYuL
2bPV41mEtD/AbSrObtqqvOaWZjwSr8JCyPdPZZAIMw==
-----END RSA PRIVATE KEY-----
`;
const rsa = crypto.createPrivateKey(RSA);
const rsaPublic = crypto.createPublicKey(rsa);
const expected = crypto.sign("sha256", Buffer.from("piped data"), rsa).toString("hex");

const signer = crypto.createSign("sha256");
signer.on("finish", () => {
  console.log("signer finish", signer.writableFinished, signer.writableEnded, signer.sign(rsa, "hex") === expected);
});
signer.on("close", () => console.log("signer close", signer.closed, signer.destroyed));
const returned = Readable.from([Buffer.from("piped "), "data"]).pipe(signer);
console.log("pipe returns the signer", returned === signer);
console.log("during", signer.writable, signer.writableEnded);

const verifier = crypto.createVerify("RSA-SHA256");
verifier.on("finish", () => {
  console.log("verifier finish", verifier.writableFinished, verifier.verify(rsaPublic, expected, "hex"));
});
verifier.on("close", () => console.log("verifier close", verifier.closed));
Readable.from([Buffer.from("piped"), " data"]).pipe(verifier);

const manual = crypto.createSign("sha256");
const source = Readable.from(["piped "]);
const piped = source.pipe(manual, { end: false });
console.log("end: false returns the signer", piped === manual);
manual.on("finish", () => console.log("manual finish", manual.sign(rsa, "hex") === expected));
source.on("end", () => {
  console.log("not ended", manual.writableEnded, manual.writableFinished);
  manual.write("data");
  manual.end();
});
