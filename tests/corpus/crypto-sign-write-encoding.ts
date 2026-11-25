// A stream write's encoding decodes the same bytes update() reads: the
// signature of a stream-fed Sign equals the one update() gives for the
// decoded bytes, for every encoding and view kind.
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

function streamed(fill: (signer: crypto.Sign) => void): string {
  const signer = crypto.createSign("sha256");
  fill(signer);
  return signer.sign(rsa, "hex");
}
function updated(bytes: Buffer): string {
  return crypto.sign("sha256", bytes, rsa).toString("hex");
}
function check(label: string, signature: string, bytes: Buffer): void {
  console.log(label, signature === updated(bytes));
}

check("utf8", streamed((s) => s.end("héllo")), Buffer.from("héllo"));
check("hex", streamed((s) => s.end("68c3a9", "hex")), Buffer.from("68c3a9", "hex"));
check("base64", streamed((s) => s.end("aGVsbG8=", "base64")), Buffer.from("aGVsbG8=", "base64"));
check("base64url", streamed((s) => s.end("aGVsbG8", "base64url")), Buffer.from("aGVsbG8", "base64url"));
check("latin1", streamed((s) => s.end("café", "latin1")), Buffer.from("café", "latin1"));
check("utf16le", streamed((s) => s.end("héllo", "utf16le")), Buffer.from("héllo", "utf16le"));
check("ascii", streamed((s) => s.end("hello", "ascii")), Buffer.from("hello", "ascii"));
check("buffer", streamed((s) => s.end(Buffer.from("hello"))), Buffer.from("hello"));
check("uint8array", streamed((s) => s.end(new Uint8Array([104, 101, 108, 108, 111]))), Buffer.from("hello"));
check("dataview", streamed((s) => s.end(new DataView(new Uint8Array([104, 105]).buffer))), Buffer.from("hi"));

const mixed = crypto.createSign("sha256");
mixed.write("68", "hex");
mixed.write(Buffer.from([0xc3]));
mixed.write("a9" as string, "hex");
mixed.write(new Uint8Array([0x68, 0x69]));
console.log("mixed", mixed.sign(rsa, "hex") === updated(Buffer.from("68c3a96869", "hex")));

const defaults = crypto.createSign("sha256");
defaults.setDefaultEncoding("hex");
defaults.write("68c3a9");
defaults.write("6869");
console.log("default encoding", defaults.sign(rsa, "hex") === updated(Buffer.from("68c3a96869", "hex")));

const endEncoding = crypto.createSign("sha256");
endEncoding.write(Buffer.from("hi"));
endEncoding.end("6869", "hex");
console.log("end encoding", endEncoding.sign(rsa, "hex") === updated(Buffer.from("68696869", "hex")));

try {
  crypto.createSign("sha256").write("x", "bogus" as BufferEncoding);
} catch (error) {
  const e = error as NodeJS.ErrnoException;
  console.log("unknown encoding", e.name, e.code, e.message);
}
