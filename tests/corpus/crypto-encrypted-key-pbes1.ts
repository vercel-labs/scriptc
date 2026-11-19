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

attempt("3des", () => createPrivateKey({ key: threeDes, passphrase: "secret" }));
attempt("2des", () => createPrivateKey({ key: twoDes, passphrase: "secret" }));
attempt("rc2", () => createPrivateKey({ key: rc2, passphrase: "secret" }));
attempt("md5-des", () => createPrivateKey({ key: md5des, passphrase: "secret" }));
attempt("3des buffer pass", () => createPrivateKey({ key: threeDes, passphrase: Buffer.from("secret") }));
attempt("3des bad pass", () => createPrivateKey({ key: threeDes, passphrase: "nope" }));
attempt("3des no pass", () => createPrivateKey({ key: threeDes }));
const der = Buffer.from(threeDes.split("\n").filter((line) => !line.includes("-----")).join(""), "base64");
attempt("3des der", () => createPrivateKey({ key: der, format: "der", type: "pkcs8", passphrase: "secret" }));
