// A recursive type that cycles through an array and a set, next to a
// certificate: the fence that refuses an X509Certificate in an `unknown`
// slot (x509.ts) walks the converted value's type, and a cycle through
// anything but a record used to recurse until the stack ran out — a crash,
// not a diagnostic. The types are named here the way a JSON-ish union is,
// and the certificate is the one 7090 parses.
import { X509Certificate } from "node:crypto";

// A self-signed certificate without alternative names (as in 7090).
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

type Rec = string | Rec[];
type RecSet = number | Set<RecSet>;

const cert = new X509Certificate(PLAIN);
const rec: Rec = ["a", ["b"]];
const set: RecSet = new Set([1, 2]);

function describe(value: unknown): string {
  return typeof value;
}

console.log(describe(rec), rec.length, describe(set), set.size);
console.log(cert.subject);
