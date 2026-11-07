// A Sign and a Verify are Writable streams: write() goes through update(),
// end() finishes the stream, and finish and close follow in Node's order.
import * as crypto from "node:crypto";

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

const events: string[] = [];
const signer = crypto.createSign("sha256");
signer.on("finish", () => {
  events.push("finish");
  console.log("finish", signer.writableFinished, signer.writableEnded, signer.writable);
  const signature = signer.sign(rsa, "hex");
  console.log("matches", signature === crypto.sign("sha256", Buffer.from("abc"), rsa).toString("hex"));
});
signer.on("close", () => {
  events.push("close");
  console.log("close", signer.closed, signer.destroyed, signer.writableFinished);
  console.log("events", events.join(","));
});
console.log("fresh", signer.writable, signer.writableEnded, signer.writableFinished, signer.destroyed, signer.closed);
console.log("hwm", signer.writableHighWaterMark, signer.writableLength, signer.writableNeedDrain);
console.log("write", signer.write("a"), signer.write(Buffer.from("b")), signer.writableLength);
signer.write("c", () => events.push("write callback"));
console.log("before end", signer.writable, signer.writableEnded, signer.writableLength);
console.log("end returns", signer.end() === signer);
console.log("after end", signer.writable, signer.writableEnded, signer.writableFinished, signer.writableLength);

const destroyed = crypto.createSign("sha256");
destroyed.write("abc");
destroyed.destroy();
destroyed.on("close", () => console.log("destroy close", destroyed.destroyed, destroyed.writableEnded));
console.log(
  "destroy signs",
  destroyed.sign(rsa, "hex") === crypto.sign("sha256", Buffer.from("abc"), rsa).toString("hex"),
);
