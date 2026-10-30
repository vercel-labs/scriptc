// X509Certificate's methods from JavaScript match Node: publicKey,
// verify, checkIssued, checkPrivateKey, checkHost, checkEmail, checkIP,
// toLegacyObject, toString and toJSON, including the TypeErrors for
// arguments of the wrong type.
import { X509Certificate, createPrivateKey, createPublicKey, createSecretKey } from "node:crypto";

// An RSA root, the EC leaf it signed, and a self-signed RSA certificate.
const ROOT = `-----BEGIN CERTIFICATE-----
MIIDPTCCAiWgAwIBAgIDChHOMA0GCSqGSIb3DQEBCwUAMD4xCzAJBgNVBAYTAlVT
MRQwEgYDVQQKDAtFeGFtcGxlIE9yZzEZMBcGA1UEAwwQRXhhbXBsZSBSU0EgUm9v
dDAgFw0yNjEwMjIwOTQ2NDFaGA8yMTI2MDkyODA5NDY0MVowPjELMAkGA1UEBhMC
VVMxFDASBgNVBAoMC0V4YW1wbGUgT3JnMRkwFwYDVQQDDBBFeGFtcGxlIFJTQSBS
b290MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwsfidupnXQcn8PUF
XaCKRYw8XKI1GUn29U5/IUGjAnJVaRmcB6BPTmblbKt4y7gLvU4h1Hxuypx8FZSZ
30eZOS1ixyrymDthG5zUHqzXk5zAGsNvZeXjN3YxTC9vX5CpQ9Uz2i+bLOi3PJsE
qyKVZ+GGT9fpIaALG11YrWmXTUko/a0AKGot0w8O/RaMpXQpkbeyTBF6f4pHNMqx
QGy+KlpC/+yIJ9psT6qyU33HF3Wa+DOy+0txAFEQNw9m1j7adOLnU0zBpkM/bnP2
fSwxMkDB2Di2P5H6PkdqLT4zBf/BLdg7WqpxxSqqgVmaSXhEqUQ6xjf51yLR3wy/
xBWhMQIDAQABo0IwQDAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAd
BgNVHQ4EFgQUCBpZW95FsDtUqpwfOMyoE/OLX8swDQYJKoZIhvcNAQELBQADggEB
AChUtpNi8dPPxA4sf4EpZhEcYBN53X3WUcG3KJGtSf8JbPKru9lK9O+sZtJADbph
WoMPdWh8g+fEMk5D6l8Y5pDk/OR++oWNY7XCLFNyigmUGn+4SopJynBQiDk2dYPV
b6swDPPiV85TuAHVn79l766rtFdHdYwRe5HvfEkiXax7Egonlx7NR73xxm/XgvHQ
jhKbTZN9k/DEjkQuo5rt9ldVupUMM0iMhDMKX5oWEx9nvRwHPbjESS+Shy/FA4nA
2WHWO++4IU+imO40an1B/8SmFF+X9hj3UE6qaZLynVZRUiouBZibwZCcdCpibFM3
kmB2s+NZXRvzhCjIxO97Ib4=
-----END CERTIFICATE-----
`;
const LEAF = `-----BEGIN CERTIFICATE-----
MIIDqjCCApKgAwIBAgICCwswDQYJKoZIhvcNAQELBQAwPjELMAkGA1UEBhMCVVMx
FDASBgNVBAoMC0V4YW1wbGUgT3JnMRkwFwYDVQQDDBBFeGFtcGxlIFJTQSBSb290
MCAXDTI2MTAyMjA5NDY0MVoYDzIxMjYwOTI4MDk0NjQxWjBfMQswCQYDVQQGEwJV
UzEUMBIGA1UECgwLRXhhbXBsZSBPcmcxGDAWBgNVBAMMD3d3dy5leGFtcGxlLmNv
bTEgMB4GCSqGSIb3DQEJARYRYWRtaW5AZXhhbXBsZS5jb20wWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAARidSirNIIrw+YHeS112z3N+1n0+uA9HjzkQ5u3QfZsRGCe
ivCEMQSs5+cUE/nv5WWda2kQWavxPGluHFtYmS10o4IBWDCCAVQwCQYDVR0TBAIw
ADALBgNVHQ8EBAMCBaAwHQYDVR0lBBYwFAYIKwYBBQUHAwEGCCsGAQUFBwMCMHsG
A1UdEQR0MHKCDSouZXhhbXBsZS5jb22CC2V4YW1wbGUuY29tghV4bi0tYmNoZXIt
a3ZhLmV4YW1wbGWBD29wc0BleGFtcGxlLmNvbYcECgAAAYcQIAENuAAAAAAAAAAA
AAAAAYYUaHR0cHM6Ly9leGFtcGxlLmNvbS8wXgYIKwYBBQUHAQEEUjBQMCQGCCsG
AQUFBzABhhhodHRwOi8vb2NzcC5leGFtcGxlLmNvbS8wKAYIKwYBBQUHMAKGHGh0
dHA6Ly9jYS5leGFtcGxlLmNvbS9jYS5jcnQwHQYDVR0OBBYEFHyUnRTDwZxUPVwZ
RKmse3fjoeMMMB8GA1UdIwQYMBaAFAgaWVveRbA7VKqcHzjMqBPzi1/LMA0GCSqG
SIb3DQEBCwUAA4IBAQAfMTcpidoH47PXOQVxRttfrG7K9BcntyXP4+5hUAoSfMr6
Rxy7X/9ba7R0yCGlNsUCusObaBpbdvwX8v9TiTYKVL+C9rEVGrTHnh6kbgZaaCQc
L3oWbfRrYnEBYuSlFuadjVvX42aqzHV28E4ITgywCxwubu2hAbacbcUHpnRSqLDq
lV+VZSQA/6cPNct7PR6AkJU80D+5wVOk7RVi4rsfbw1wFDeksCHu+0EThs9zjzL+
S7HTCjB6AOHpbu1Sx+0d5YEKSE7EPF+dSFATNbhjTHzYQySnHK+Lm8nON8wmY1rC
7opOhvUlid1jA1d2BKO2ZxlxLir4pyIehTC1ddG2
-----END CERTIFICATE-----
`;
const PLAIN = `-----BEGIN CERTIFICATE-----
MIIC8jCCAdoCAQcwDQYJKoZIhvcNAQELBQAwPjEaMBgGA1UEAwwRcGxhaW4uZXhh
bXBsZS5vcmcxIDAeBgkqhkiG9w0BCQEWEXBsYWluQGV4YW1wbGUub3JnMCAXDTI2
MTAyMjA5NDY0MVoYDzIxMjYwOTI4MDk0NjQxWjA+MRowGAYDVQQDDBFwbGFpbi5l
eGFtcGxlLm9yZzEgMB4GCSqGSIb3DQEJARYRcGxhaW5AZXhhbXBsZS5vcmcwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCq01NcNAy9Ng04mVuAFvmZUvsm
rY7aOaMgtODmptulgZ2qw25E09RgGYCn1S+4IYDu9hH9X4s+28Ag7Khmj4nmeoXN
of5095wche8DR2AAUElqyr/Nmgm2kTLdIJX4wl0eWXHIlmSPdOUNovA6JjGKH99b
8W7a2TqY/TsSadpPSvvN2esr7Jr4KgW7MXPUOnwNbcBOVcQP9rtFrduAWz01q0HM
02LboclnUnk/e58BXAj8vgdVojljDcc0bhbdz/Hh1/5gaaNILjJNOd4AgwZaCT02
KojGz4Nb6MSgFmON2iMgAZjY1fXXkJ7wsfVPytjW73e7uV/RFuqSHQZenxupAgMB
AAEwDQYJKoZIhvcNAQELBQADggEBAJX1DGuiSLoCKBDI3oCgAu7X86G01ovEgZJr
8JrmGHW5q7ujjo53t46h8XPm3LJ8UV9/MZ+Yry43xB2txXYv3b3g/i+7JdTWLgUD
INA5VWvVkEZfm0lBEpU1Agpy4lV5uUCKZTgP/3MY5hnJ0YhQIs4BOjbwueMRFshL
yyHVb73MMbpWaZ7+T368seafa+ekeuY6gQly/HacuszjoYd6KKV3n8eDewenClCF
HoOF1Y4I+CvmR+a6B3iBczJ+a4tceFIIWsZUIeqzvGHpM7G9YwlmbvGprfLgR8Nv
igUib/D9tU3hdL6VWN5nMjdXV/8Le4nDnBjVBjYDkVbsnmT91AQ=
-----END CERTIFICATE-----
`;
const ROOT_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDCx+J26mddByfw
9QVdoIpFjDxcojUZSfb1Tn8hQaMCclVpGZwHoE9OZuVsq3jLuAu9TiHUfG7KnHwV
lJnfR5k5LWLHKvKYO2EbnNQerNeTnMAaw29l5eM3djFML29fkKlD1TPaL5ss6Lc8
mwSrIpVn4YZP1+khoAsbXVitaZdNSSj9rQAoai3TDw79FoyldCmRt7JMEXp/ikc0
yrFAbL4qWkL/7Ign2mxPqrJTfccXdZr4M7L7S3EAURA3D2bWPtp04udTTMGmQz9u
c/Z9LDEyQMHYOLY/kfo+R2otPjMF/8Et2DtaqnHFKqqBWZpJeESpRDrGN/nXItHf
DL/EFaExAgMBAAECggEADsvlabgryvbYs2bBlhe0eU0KZtURqI6kWoUwhiO40N5D
m7zMzA2DCMcrRYKPJhagmaxeSIh9WBnkGTWVLM+BFcVbXBrom+Ti3xieSohBxh5h
v4a6Jyj8BkINw6ZU1RMlsJf5HOmB5br19H4oMCHr7JzGubkCpkHEpjsEmgPL8Rxs
LYb9palDyTD1z5xVAQDAkvnCYQMX2DsiH8RuO4Ih0OoWMIsAGasS1dTQCkOzN9wF
cMg+hmJvQLN5xLYI+VPy/iZn+bmerCx8/NQBrbo+zibmnv7cDK1U9emVD70/Nd1d
B7ZEm+a4gReaxWVQGEkFMvs29u/TDWXYRnw0PGjUYwKBgQDrmKEx+ZiZwNNk/S3l
s8FgVrLFDr/+t5X33jaD5nVuSN6/AoR3qfh9piIyCrdNKdHicAcCnWP6skUFYLq3
/tyMBATX3j+f3PHW3i2ZUAK26hgfp66F/3IyowePZbBDlGSmGsffVlc8on5fCk1Q
k3G0znktbrMCNxeeY9GSi1CHewKBgQDTpled6pZepZ54OGnKVJFo6DbQC0l4HQ6y
Rwv9BMtAz+AxWXda1oYK5bbJZrCmHyVP85VxkzRHOMxicv7M2kR9y2zZsJD7INqr
Nvt+lo2yGtIGv7kOdwWzvs4Pn7aCWSApzYBjuKrpP1xDzaMHhusAQtkk77YGCZCu
cCAQ/FjEQwKBgBq/1KWI8lOauiXAPULUWwNmNJv9Jb10+LkQ6N2m//RKn8fOMF4p
1UXm5AEMiG1hbywnjhQ07JIdRYrrxad4b3ASUL51xIGRI4BC76h1lilQgPavIjii
nUO0kPouEIpLwfW+Gq137yW6SWDfGZIpe4KM4uNOq1J4EN1x9eyOltEbAoGAP4bj
L5QVFE2T1jPglQlzJ9DjeuiYYcQfACXRFF3XABolCcr3xz0yuJygk60OAp7AnVHY
nmF3xJToy/gGQMiW3Ect4d1cdvQyjkePjzxzRW1Fcx8i1ZOmE4CG6yueJVvJCqMT
EVuBeUc6U2Oqtnyplsd509tbgE5oreMbzN1ha28CgYAHpG10ZQRDeqWFIo/ttk6Q
Q1Gf53eqZFCgh8GO1hBJ7+Fp+Ec5S9UPMBDjZb6GET7ifF8Zit/lR4gN2PuELwJA
YaXTIehCugH7Q3oTjNcQtls6tW+/+jEGjbjSHyZvwk8EFHc0J7PWRszB36s+qM+O
YPorNipExSeWti1506ljLQ==
-----END PRIVATE KEY-----
`;
const LEAF_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEINqbifA6kN/DSN0cMD2s7fXiNtPXZqipFrbCs/3mCGbtoAoGCCqGSM49
AwEHoUQDQgAEYnUoqzSCK8PmB3ktdds9zftZ9PrgPR485EObt0H2bERgnorwhDEE
rOfnFBP57+VlnWtpEFmr8TxpbhxbWJktdA==
-----END EC PRIVATE KEY-----
`;

const ca = new X509Certificate(ROOT);
const leaf = new X509Certificate(Buffer.from(LEAF));
const plain = new X509Certificate(PLAIN);
const caKey = createPrivateKey(ROOT_KEY);
const leafKey = createPrivateKey(LEAF_KEY);
function t(label, f) {
  try {
    const v = f();
    console.log(label, typeof v === "string" ? JSON.stringify(v) : v);
  } catch (e) {
    console.log(label, "THROW", e.name, e.code, e.message);
  }
}
t("pub", () => [leaf.publicKey.asymmetricKeyType, ca.publicKey.asymmetricKeyType, ca.publicKey.asymmetricKeyDetails.modulusLength]);
t("pub same", () => leaf.publicKey === leaf.publicKey);
t("pub equals", () => leaf.publicKey.equals(createPublicKey(leafKey)));
t("verify ca", () => leaf.verify(ca.publicKey));
t("verify self", () => leaf.verify(leaf.publicKey));
t("verify ca self", () => ca.verify(ca.publicKey));
t("verify private", () => leaf.verify(caKey));
t("verify string", () => leaf.verify("x"));
t("verify secret", () => leaf.verify(createSecretKey(Buffer.alloc(16))));
t("issued", () => [leaf.checkIssued(ca), ca.checkIssued(leaf), ca.checkIssued(ca), plain.checkIssued(plain), leaf.checkIssued(plain)]);
t("issued bad", () => leaf.checkIssued({}));
t("pk", () => [leaf.checkPrivateKey(leafKey), leaf.checkPrivateKey(caKey), ca.checkPrivateKey(caKey)]);
t("pk public", () => leaf.checkPrivateKey(leaf.publicKey));
t("pk string", () => leaf.checkPrivateKey("x"));
for (const h of ["www.example.com", "foo.example.com", "a.b.example.com", "example.com", "EXAMPLE.COM", "xn--bcher-kva.example", "other.org", "10.0.0.1", "", "foo.example.com."]) t("host " + h, () => leaf.checkHost(h));
t("host plain", () => plain.checkHost("plain.example.org"));
t("host plain never", () => plain.checkHost("plain.example.org", { subject: "never" }));
t("host leaf always", () => leaf.checkHost("www.example.com", { subject: "always" }));
t("host nowild", () => leaf.checkHost("foo.example.com", { wildcards: false }));
t("host partial", () => leaf.checkHost("foo.example.com", { partialWildcards: false }));
t("host multi", () => leaf.checkHost("a.b.example.com", { multiLabelWildcards: true }));
t("host single", () => leaf.checkHost("example.com", { singleLabelSubdomains: true }));
t("host num", () => leaf.checkHost(1));
t("host opts bad", () => leaf.checkHost("x", { subject: "sometimes" }));
t("host opts type", () => leaf.checkHost("x", 5));
t("host wild type", () => leaf.checkHost("x", { wildcards: "yes" }));
for (const e of ["ops@example.com", "OPS@EXAMPLE.COM", "admin@example.com", "nobody@example.com"]) t("email " + e, () => leaf.checkEmail(e));
t("email plain", () => plain.checkEmail("plain@example.org"));
t("email plain never", () => plain.checkEmail("plain@example.org", { subject: "never" }));
t("email num", () => leaf.checkEmail(1));
for (const ip of ["10.0.0.1", "2001:db8::1", "2001:DB8:0:0:0:0:0:1", "10.0.0.2", "::ffff:10.0.0.1", "bogus", ""]) t("ip " + ip, () => leaf.checkIP(ip));
t("ip num", () => leaf.checkIP(1));
t("ip opts", () => leaf.checkIP("10.0.0.1", {}));
for (const cert of [leaf, ca, plain]) {
  const legacy = cert.toLegacyObject();
  console.log(Object.keys(legacy).join(","), legacy.subject.CN, legacy.bits, legacy.raw.length);
}
t("pem", () => [leaf.toString() === leaf.toJSON(), String(ca) === `${ca}`, ca.toString().split("\n").length]);
t("pem round trip", () => new X509Certificate(plain.toJSON()).fingerprint === plain.fingerprint);
