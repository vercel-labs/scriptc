// Writing to a Sign or Verify after end() fails the way Node's Writable
// does: write() answers false, 'error' carries ERR_STREAM_WRITE_AFTER_END,
// and a second end() reports the same error.
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

function code(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  return `${e.name} ${e.code} ${e.message}`;
}

const signer = crypto.createSign("sha256");
signer.end("abc");
console.log("after end", signer.writable, signer.writableEnded, signer.writableFinished, signer.destroyed);
signer.on("error", (error: Error) => console.log("error", code(error)));
signer.on("close", () => console.log("close", signer.closed, signer.destroyed));
console.log("write after end", signer.write("more"));
console.log("state", signer.writable, signer.writableEnded, signer.destroyed);
signer.write("again", (error?: Error | null) => console.log("callback", error ? code(error) : "none"));

const twice = crypto.createSign("sha256");
twice.write("abc");
twice.end();
twice.on("error", (error: Error) => console.log("second error", code(error)));
twice.on("close", () => console.log("second close", twice.closed));
twice.end("more");
console.log("second end", twice.writableEnded, twice.writableFinished);

const verifier = crypto.createVerify("RSA-SHA256");
verifier.end("abc");
verifier.on("error", (error: Error) => console.log("verify error", code(error)));
verifier.write("more");
verifier.on("close", () => console.log("verify close", verifier.destroyed));

const throws = crypto.createSign("sha256");
const bad: unknown[] = [null, 42, undefined];
for (const value of bad) {
  try {
    throws.write(value as any);
  } catch (error) {
    console.log("write", value, code(error));
  }
}
throws.end();
console.log("still usable", throws.sign(rsa, "hex").length);
