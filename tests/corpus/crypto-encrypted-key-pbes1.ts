// node:crypto createPrivateKey over PBES1 (PKCS#12 PBE) encrypted PKCS#8:
// the PKCS#12 3DES schemes decrypt as in Node, the RC2 and MD5-DES ones
// report the provider's unsupported-encryption error, and the passphrase
// errors match.
import { createPrivateKey } from "node:crypto";

const log = (...a: unknown[]) => console.log(a.map(String).join(" | "));
const attempt = (label: string, run: () => unknown): void => {
  try { const k = run() as { type: string; asymmetricKeyType: string }; log(label, "ok", k.type, k.asymmetricKeyType); }
  catch (e) { const x = e as Error & { code?: string }; log(label, "|", x.name, x.code, "|", x.message); }
};

const threeDes = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIGxMBwGCiqGSIb3DQEMAQMwDgQIOKgXZ3j77NgCAggABIGQ7WHttfnjAmakVYjg
s1epjq7afYHqeKkWR3c+CujSM8zQwi0OxNEFor6BYeTDfIgfbVr9v7CfllzhRPok
XQ4bbRoXxkeOFyoHU0Y8LmkmQsYO025UurPKeHHHBrDmlwI1U9rY74s+C/VFNV12
u/pf7cgohGYVQ3FPA7gTWje1f2cNgyXksy3ln3baXZMO7g4m
-----END ENCRYPTED PRIVATE KEY-----\n`;
const twoDes = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIGxMBwGCiqGSIb3DQEMAQQwDgQIQyk0Cy7+zF0CAggABIGQRrfG6bmD4PnpYMRV
Y1osmNvV6pC7R55xaUNQyPagjuiTFdUkztSPyfsn842PynQGV3kGkC3dzzRxKx/0
m1K2uuk/xSTGEncjEy2O72dRiPbOvNM75L87dHJK+abBZ1TobGoHQfliNFg92k3J
MZCQacpV6vqUmzLjgoLtyC/ajrvOxPPl/7lzeDe5VJNb/z16
-----END ENCRYPTED PRIVATE KEY-----\n`;
const rc2 = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIGxMBwGCiqGSIb3DQEMAQYwDgQIAhJsyzUJTBYCAggABIGQ7YtU351Ot8qEFInm
VslqPfULocG386E0Tuyc5cmprU9X/A2u1H0ri8kxJSbrbbMXOVKjiy/V+YU59/8/
vAabos6xwJR1tRuA7+a6m06SwB2Q3M3oXZBlNwTNIlR3H+3bmO3suvsS1ur4zQr/
/uHM8GsX4StWiiVgjN1lhCxpT/U+s5t5o+K4zpGne1mMrixn
-----END ENCRYPTED PRIVATE KEY-----\n`;
const md5des = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIGwMBsGCSqGSIb3DQEFAzAOBAhcZLvmMcVaegICCAAEgZDlWlBFTEZh0/xVqZTQ
l3TV38A8qrNw4FQ7U670yraWRoKecfqZT4F76KW7X1B2n6K5ky+FleWxDgUq8FAD
zNKMKfPECeH5h5rMRFtr159u7h8BBfDlzs6gs6KtfabiZVxB/Ih92/H0Zmp4SeKj
P/JBvE92Y2uoRhXvODAurrc1eCHZdtPq6JZ3TJdTnd3WdRg=
-----END ENCRYPTED PRIVATE KEY-----\n`;

const uniPass = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIGxMBwGCiqGSIb3DQEMAQMwDgQIMcwZqgxn7MICAggABIGQK1yAAZgwBf7RDPA7
cZrB50ez/FPQs+ctjMSRVUrk7bti1VMD5sUUJBCVG5b9q2xgUDbfwmnI3Z+OKYhj
hfyqq2JmTyKoAy8ffBSFfkuQPqa85Fx094A8DPWIOFdpHG/jfLlv+rt9BCEKskxW
5EY/YQ+pbmuQ6UxItYqCNrZjz4NXjlK4o7bLPlqFq5CLsvFv
-----END ENCRYPTED PRIVATE KEY-----\n`;
attempt("3des unicode", () => createPrivateKey({ key: uniPass, passphrase: "sécrét" }));
attempt("3des unicode buffer", () => createPrivateKey({ key: uniPass, passphrase: Buffer.from("sécrét", "utf8") }));
attempt("3des latin1 buffer", () =>
  createPrivateKey({ key: uniPass, passphrase: Buffer.from([0x73, 0xe9, 0x63, 0x72, 0xe9, 0x74]) }));
const mixedPass = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIGxMBwGCiqGSIb3DQEMAQMwDgQIcqK5ujKVUE0CAggABIGQ/zPtyLcSZHYRp9Ns
A2Y2CTbCMxkzhAvw+V4wRFMDFsTPVaTmHGv+ESD48VO4jPj7vG2qfyNWPy/zDqG6
+9+nS+KLOmQ87EAVoZBYQtQM0N2NiU0sBUaVN5VM1gtUXEZ4+/eB4GAaHPk0z2De
/si+OvWzdX0WvyjYGbRjySUTMau+iw5sAJTFBwSB/sINNIRP
-----END ENCRYPTED PRIVATE KEY-----\n`;
attempt("3des mixed buffer", () =>
  createPrivateKey({ key: mixedPass, passphrase: Buffer.from([0xc3, 0xa9, 0xff, 0x78]) }));
const emojiPass = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIGxMBwGCiqGSIb3DQEMAQMwDgQIaFKrQ9alXf0CAggABIGQUVMX4L/ka7JO2xwl
z8qf/cuOjpmnrCcKSZS36BnVqAc65tst72q+rFGo+Wi/XwuEVaG5nen5eWJUnzMS
zZ+yQHM9KlgFr74azPyEiEsRHgL5NrYDXTS2eL9X40wOBH4WRJ22yf1GSreaaniM
LQCuJ4gQmt7PLW4DcGm22Stk6UCsYPsbB7j4ell68zB6PqHA
-----END ENCRYPTED PRIVATE KEY-----\n`;
attempt("3des emoji", () => createPrivateKey({ key: emojiPass, passphrase: "\u{1F600}" }));
attempt("3des emoji buffer", () =>
  createPrivateKey({ key: emojiPass, passphrase: Buffer.from([0xf0, 0x9f, 0x98, 0x80]) }));
attempt("3des surrogate bytes", () =>
  createPrivateKey({ key: emojiPass, passphrase: Buffer.from([0xed, 0xa0, 0x80]) }));
attempt("3des", () => createPrivateKey({ key: threeDes, passphrase: "secret" }));
attempt("2des", () => createPrivateKey({ key: twoDes, passphrase: "secret" }));
attempt("rc2", () => createPrivateKey({ key: rc2, passphrase: "secret" }));
attempt("md5-des", () => createPrivateKey({ key: md5des, passphrase: "secret" }));
attempt("3des buffer pass", () => createPrivateKey({ key: threeDes, passphrase: Buffer.from("secret") }));
attempt("3des shared passphrase", () => {
  const shared = new SharedArrayBuffer(6);
  const passphrase = Buffer.from(shared);
  passphrase.write("secret", "utf8");
  return createPrivateKey({ key: threeDes, passphrase });
});
attempt("3des bad pass", () => createPrivateKey({ key: threeDes, passphrase: "nope" }));
attempt("3des no pass", () => createPrivateKey({ key: threeDes }));
const der = Buffer.from(threeDes.split("\n").filter((line) => !line.includes("-----")).join(""), "base64");
attempt("3des der", () => createPrivateKey({ key: der, format: "der", type: "pkcs8", passphrase: "secret" }));
