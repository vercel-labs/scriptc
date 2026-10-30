// X509Certificate.checkHost, checkEmail and checkIP match Node: the
// subject alternative names of the asked kind first, then the subject's
// common name or emailAddress when the certificate has none (or as the
// subject option says), the wildcard rules and their options, case rules,
// IPv4 and IPv6 parsing, and an invalid subject option.
import { X509Certificate, type X509CheckOptions } from "node:crypto";

// DNS names with every wildcard form, an IP address and an email name.
const WILD = `-----BEGIN CERTIFICATE-----
MIIB/TCCAaOgAwIBAgIBCTAKBggqhkjOPQQDAjAXMRUwEwYDVQQDDAwqLmNuLmV4
YW1wbGUwIBcNMjYxMDIyMTAwMTMxWhgPMjEyNjA5MjgxMDAxMzFaMBcxFTATBgNV
BAMMDCouY24uZXhhbXBsZTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABGJ1KKs0
givD5gd5LXXbPc37WfT64D0ePORDm7dB9mxEYJ6K8IQxBKzn5xQT+e/lZZ1raRBZ
q/E8aW4cW1iZLXSjgd0wgdowgbgGA1UdEQSBsDCBrYIOZiouZXhhbXBsZS5jb22C
Dypvby5leGFtcGxlLm5ldIIXKi54bi0tYmNoZXIta3ZhLmV4YW1wbGWCDXhuLS0q
LmV4YW1wbGWCBSouY29tgg9hLiouZXhhbXBsZS5vcmeCASqCDyouTWl4ZWQuRXhh
bXBsZYIMLmRvdC5leGFtcGxlgg9iKnouZXhhbXBsZS5lZHWHBMCoAQGBEU1peGVk
QEV4YW1wbGUuQ09NMB0GA1UdDgQWBBR8lJ0Uw8GcVD1cGUSprHt346HjDDAKBggq
hkjOPQQDAgNIADBFAiALkTbNe6bIavd8T9qKlAqzmEPQrFRZUVoOHSQPI/zV5QIh
AM0et8JtbWP+4ySiUPPqCXtlup00GfhcqGXy+lSl32vL
-----END CERTIFICATE-----
`;

// No alternative names; the subject has a wildcard CN and an emailAddress.
const CN = `-----BEGIN CERTIFICATE-----
MIIBVDCB+gIBCjAKBggqhkjOPQQDAjA1MRcwFQYDVQQDDA5zZWNvbmQuZXhhbXBs
ZTEaMBgGCSqGSIb3DQEJARYLYUBiLmV4YW1wbGUwIBcNMjYxMDIyMTAwMTMxWhgP
MjEyNjA5MjgxMDAxMzFaMDUxFzAVBgNVBAMMDnNlY29uZC5leGFtcGxlMRowGAYJ
KoZIhvcNAQkBFgthQGIuZXhhbXBsZTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IA
BGJ1KKs0givD5gd5LXXbPc37WfT64D0ePORDm7dB9mxEYJ6K8IQxBKzn5xQT+e/l
ZZ1raRBZq/E8aW4cW1iZLXQwCgYIKoZIzj0EAwIDSQAwRgIhAIE0IFtuCNllBodV
go5WWgb8h1McrS/o31V5K0JrpF7QAiEAil8AEHuMiVtef/txZsEKPPojDKfPTYC8
zplMuFd9gQA=
-----END CERTIFICATE-----
`;

// A leaf with DNS, email, IPv4, IPv6 and URI names.
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

// A self-signed certificate without alternative names.
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

const wild = new X509Certificate(WILD);
const cn = new X509Certificate(Buffer.from(CN));
const leaf = new X509Certificate(LEAF);
const plain = new X509Certificate(PLAIN);

const hosts = [
  "foo.example.com", "f.example.com", "fx.example.com", "a.b.example.com", "foo.example.net",
  "oo.example.net", "x.xn--bcher-kva.example", "xn--abc.example", "example.com",
  "a.b.example.org", "x", "a.mixed.example", "A.MIXED.EXAMPLE", "a.dot.example", ".dot.example",
  "dot.example", "bz.example.edu", "baz.example.edu", "b.z.example.edu", "x.cn.example",
  "second.example", "192.168.1.1", ".example.com", ".mixed.example", "a.b.mixed.example",
];
const opts: [string, X509CheckOptions | undefined][] = [
  ["default", undefined],
  ["nowild", { wildcards: false }],
  ["nopartial", { partialWildcards: false }],
  ["multi", { multiLabelWildcards: true }],
  ["single", { singleLabelSubdomains: true }],
  ["always", { subject: "always" }],
  ["never", { subject: "never" }],
];
for (const [label, o] of opts) {
  console.log(label, hosts.map((h) => `${h}=${wild.checkHost(h, o)}`).join(" "));
  console.log(label, "cn", hosts.map((h) => `${h}=${cn.checkHost(h, o)}`).join(" "));
}

for (const h of ["www.example.com", "example.com", "EXAMPLE.COM", "xn--bcher-kva.example", "", "foo.example.com."]) {
  console.log("leaf", JSON.stringify(h), leaf.checkHost(h), leaf.checkHost(h, { subject: "always" }));
}
console.log("plain", plain.checkHost("plain.example.org"), plain.checkHost("plain.example.org", { subject: "never" }));
const found: string | undefined = leaf.checkHost("api.example.com");
console.log("typed", found === undefined ? "none" : found.toUpperCase());

for (const e of ["Mixed@example.com", "mixed@example.com", "Mixed@EXAMPLE.COM", "a@b.example", "a@B.EXAMPLE", "A@b.example"]) {
  console.log("email", e, wild.checkEmail(e), cn.checkEmail(e), cn.checkEmail(e, { subject: "never" }));
}
for (const e of ["ops@example.com", "OPS@EXAMPLE.COM", "admin@example.com"]) console.log("email", e, leaf.checkEmail(e));
console.log("email plain", plain.checkEmail("plain@example.org"), plain.checkEmail("plain@example.org", { subject: "always" }));

const ips = [
  "192.168.1.1", "192.168.001.001", "192.168.1.1.", "1.2.3", "::", "::ffff:192.168.1.1",
  "0:0:0:0:0:0:0:0", "1::2::3", "fe80::1%eth0", " 192.168.1.1", "192.168.1.256",
  "10.0.0.1", "2001:db8::1", "2001:DB8:0:0:0:0:0:1", "2001:db8:0::0:1", "::ffff:10.0.0.1", "",
];
for (const ip of ips) {
  try {
    console.log("ip", JSON.stringify(ip), wild.checkIP(ip), leaf.checkIP(ip));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("ip", JSON.stringify(ip), err.name, err.code, err.message);
  }
}

try {
  leaf.checkHost("www.example.com", { subject: "sometimes" as "always" });
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log("subject", err.name, err.code, err.message);
}
