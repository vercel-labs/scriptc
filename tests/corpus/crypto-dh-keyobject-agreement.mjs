// crypto.diffieHellman with DH KeyObjects: two keys over the same group
// agree on the padded secret, a fixed pair answers Node's exact bytes, a
// private key works in the public slot, and the type and
// domain-parameter errors match Node's.
import * as crypto from "node:crypto";

const A_PRIV = `-----BEGIN PRIVATE KEY-----
MIH5AgEAMIHVBgkqhkiG9w0BAwEwgccCgcEA///////////JD9qiIWjCNMTGYouA
3BzRKQJOCIpnzHQCC76mOxObIlFKCHmONATd75UZs806QxswKwpt8l8UN0/hNW1t
UcJF5IW1dmJefsb0TELppjftawv/XLb0Brft7jhr+1qJn6WunyQRfEsf5kkoZlHs
5Fs9wgB8uKFjvwWY2kg2HFXTmmkWP6j9JM9fg2VdI9yjrZYcYvNWIIVSu57VKQdw
lpZtZww1Tkq8mATxdGwIyiNzJ///////////AgECBBwCGgDdXR+oW6OYYb7oyeUB
ZlSK9PbAYEphsWuS
-----END PRIVATE KEY-----
`;
const A_PUB = `-----BEGIN PUBLIC KEY-----
MIIBnzCB1QYJKoZIhvcNAQMBMIHHAoHBAP//////////yQ/aoiFowjTExmKLgNwc
0SkCTgiKZ8x0Agu+pjsTmyJRSgh5jjQE3e+VGbPNOkMbMCsKbfJfFDdP4TVtbVHC
ReSFtXZiXn7G9ExC6aY37WsL/1y29Aa37e44a/taiZ+lrp8kEXxLH+ZJKGZR7ORb
PcIAfLihY78FmNpINhxV05ppFj+o/STPX4NlXSPco62WHGLzViCFUrue1SkHcJaW
bWcMNU5KvJgE8XRsCMojcyf//////////wIBAgOBxAACgcASsM2v97vuBrV+yZCu
TnCmbhvrCeCEelLMr22eLzj5iYAfFzDVi66XHLyBaRvNffQz0DYVzlDMqavF31YQ
gk3C/8aU/O/omybdjs20KDHvziVCloIxVJmzGOlyXHR91Y7GcknV09POYxIdUvEI
3ioz1bqeLCofunx4yt2pU/7tq9nPvdolIGQs2xbP0RT3/5bj1V8GTNn4I/oR9Uj8
AX3sRyM7ReuEXX8nNRhqr59EHryP/c/E2+vdWlizCVMN9W8=
-----END PUBLIC KEY-----
`;
const B_PRIV = `-----BEGIN PRIVATE KEY-----
MIH5AgEAMIHVBgkqhkiG9w0BAwEwgccCgcEA///////////JD9qiIWjCNMTGYouA
3BzRKQJOCIpnzHQCC76mOxObIlFKCHmONATd75UZs806QxswKwpt8l8UN0/hNW1t
UcJF5IW1dmJefsb0TELppjftawv/XLb0Brft7jhr+1qJn6WunyQRfEsf5kkoZlHs
5Fs9wgB8uKFjvwWY2kg2HFXTmmkWP6j9JM9fg2VdI9yjrZYcYvNWIIVSu57VKQdw
lpZtZww1Tkq8mATxdGwIyiNzJ///////////AgECBBwCGgDMgEPnh8BspYawH01w
VWiwCZEIN7xFdchp
-----END PRIVATE KEY-----
`;
const B_PUB = `-----BEGIN PUBLIC KEY-----
MIIBoDCB1QYJKoZIhvcNAQMBMIHHAoHBAP//////////yQ/aoiFowjTExmKLgNwc
0SkCTgiKZ8x0Agu+pjsTmyJRSgh5jjQE3e+VGbPNOkMbMCsKbfJfFDdP4TVtbVHC
ReSFtXZiXn7G9ExC6aY37WsL/1y29Aa37e44a/taiZ+lrp8kEXxLH+ZJKGZR7ORb
PcIAfLihY78FmNpINhxV05ppFj+o/STPX4NlXSPco62WHGLzViCFUrue1SkHcJaW
bWcMNU5KvJgE8XRsCMojcyf//////////wIBAgOBxQACgcEAxqqdNRrv1fhnkuJo
iLcbncH5TTDW39drRZJSWs67Q28kdT5+mwP3uWJ7/FTaIPcA+EHt4a/mF9YW10Ug
chjRdxrVojvnJX+58BUPZGVsc1BzGwahayyQQB/YqnJ9nviumcyfup9QyXDMiVBX
D07bih5kPeHuiUaTF+K5DQxyOOt3RWYtoIkxngG3NqnhGPKDCmRVLI4+HuV0q5Rr
2IHOpqEfriieu02GtfEBoZ/Au39hUeGknCJ08ASqCaE45taT
-----END PUBLIC KEY-----
`;

const aPriv = crypto.createPrivateKey(A_PRIV);
const aPub = crypto.createPublicKey(A_PUB);
const bPriv = crypto.createPrivateKey(B_PRIV);
const bPub = crypto.createPublicKey(B_PUB);

const ab = crypto.diffieHellman({ privateKey: aPriv, publicKey: bPub });
const ba = crypto.diffieHellman({ privateKey: bPriv, publicKey: aPub });
console.log("fixed", ab.length, ab.toString("base64"), ab.equals(ba));

console.log("private as public", crypto.diffieHellman({ privateKey: aPriv, publicKey: bPriv }).equals(ab));

const pair = crypto.generateKeyPairSync("dh", { group: "modp14" });
const other = crypto.generateKeyPairSync("dh", { group: "modp14" });
const s1 = crypto.diffieHellman({ privateKey: pair.privateKey, publicKey: other.publicKey });
const s2 = crypto.diffieHellman({ privateKey: other.privateKey, publicKey: pair.publicKey });
console.log("generated", s1.length, s1.equals(s2));

const attempt = (label, f) => {
  try {
    f();
  } catch (e) {
    console.log(label, "THROW", e.name, e.code, e.message);
  }
};
attempt("different groups", () => crypto.diffieHellman({ privateKey: aPriv, publicKey: pair.publicKey }));
const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
attempt("dh and ec", () => crypto.diffieHellman({ privateKey: aPriv, publicKey: ec.publicKey }));
attempt("ec and dh", () => crypto.diffieHellman({ privateKey: ec.privateKey, publicKey: aPub }));
attempt("public in private slot", () => crypto.diffieHellman({ privateKey: aPub, publicKey: bPub }));

crypto.diffieHellman({ privateKey: aPriv, publicKey: bPub }, (err, secret) => {
  console.log("async", err === null, secret.equals(ab));
});
