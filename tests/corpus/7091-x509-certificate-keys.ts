// X509Certificate.publicKey, verify, checkIssued and checkPrivateKey match
// Node: the public key as a cached KeyObject, signature checks for RSA
// PKCS#1, RSA-PSS, ECDSA and Ed25519 signatures, issuer checks by name,
// key identifier and key type, private key matches, and the pkey errors.
import {
  X509Certificate,
  constants,
  createPrivateKey,
  createPublicKey,
  createSecretKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

// An RSA root and the EC leaf it signed.
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
// A self-signed RSA certificate and a self-signed Ed25519 certificate.
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
const ED = `-----BEGIN CERTIFICATE-----
MIIBljCCAUigAwIBAgIUNFuRt3zKS19UAUMdLWewqHrGBigwBQYDK2VwMC8xFDAS
BgNVBAoMC0V4YW1wbGUgT3JnMRcwFQYDVQQDDA5lZC5leGFtcGxlLm5ldDAgFw0y
NjEwMjIxMDEwMTJaGA8yMTI2MDkyODEwMTAxMlowLzEUMBIGA1UECgwLRXhhbXBs
ZSBPcmcxFzAVBgNVBAMMDmVkLmV4YW1wbGUubmV0MCowBQYDK2VwAyEAOCSLKkel
kOH/5aqUwI3PNJVUUNyhgu2s19LFC254fNCjdDByMB0GA1UdDgQWBBR+50zUcqL8
739jh6/rEYojULDmlTAfBgNVHSMEGDAWgBR+50zUcqL8739jh6/rEYojULDmlTAP
BgNVHRMBAf8EBTADAQH/MB8GA1UdEQQYMBaCDmVkLmV4YW1wbGUubmV0hwTAAAIH
MAUGAytlcANBAC/c0Bi0SVUnHCg/1pn7MaCgVivSHuoISi2SCq/0EnLefRdgsIir
0QxjVnxeuKN2Y1yfEO/R1W8Nwovo1l2M1gQ=
-----END CERTIFICATE-----
`;
// A second RSA root with its EC leaf, a self-signed RSA-PSS certificate
// and a self-signed v1 certificate with the second leaf's subject.
const ROOT2 = `-----BEGIN CERTIFICATE-----
MIIEITCCAwmgAwIBAgIIASNFZ4mrze8wDQYJKoZIhvcNAQELBQAwgZwxCzAJBgNV
BAYTAlVTMRMwEQYDVQQIDApDYWxpZm9ybmlhMRYwFAYDVQQHDA1TYW4gRnJhbmNp
c2NvMRQwEgYDVQQKDAtFeGFtcGxlIE9yZzERMA8GA1UECwwIRGV2IFRlYW0xGDAW
BgNVBAMMD0V4YW1wbGUgUm9vdCBDQTEdMBsGCSqGSIb3DQEJARYOY2FAZXhhbXBs
ZS5jb20wIBcNMjYxMDIxMTYzMzUyWhgPMjEyNjA5MjcxNjMzNTJaMIGcMQswCQYD
VQQGEwJVUzETMBEGA1UECAwKQ2FsaWZvcm5pYTEWMBQGA1UEBwwNU2FuIEZyYW5j
aXNjbzEUMBIGA1UECgwLRXhhbXBsZSBPcmcxETAPBgNVBAsMCERldiBUZWFtMRgw
FgYDVQQDDA9FeGFtcGxlIFJvb3QgQ0ExHTAbBgkqhkiG9w0BCQEWDmNhQGV4YW1w
bGUuY29tMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0YGcCr0pxR8d
6qDdLuILcoT7vhtAjyHwfkoChnH6N3TLWzDUugnBp9NbDb7gDLqbRT4uTDoNb6zS
tEJZ4Q7/hhd0jDvoPmOy0Y3Kyj9uNsdf25GdbvwwEnlddELJCZprTZ4OhEg6w2s0
Yy4SlviLzDXLmsggTypxeS+K8JHT9onMipi5L4GFu8n1QZbzXvSS4BkRgMXEyrtr
FOE9qSo2qkubFyd/WNKRTRIpTSc5/GGsqJ0FKDDJnN5adotcUucbJFn4noNnFUWh
M8mhBEj7ENDdJsD2EVFsI6H958jA2SbNNu4ngzAOs2AKNBYBfQK02ZQAdRNOSL3K
5FkfbII5LwIDAQABo2MwYTAdBgNVHQ4EFgQUP+yQyItpNYEls26Jfv+NnciGaK8w
HwYDVR0jBBgwFoAUP+yQyItpNYEls26Jfv+NnciGaK8wDwYDVR0TAQH/BAUwAwEB
/zAOBgNVHQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQELBQADggEBABDw3Va/C+RFc/Hs
TJnHtQJtxFL0ZhnHUqg4DcDA3m+JDdIDNL8sNpLEbtn/pr0VeEWgG+MImWAQlrUW
IAZkLj9/Zg1wSO0oZ86ZyZJZmp54lUYXgG17CNl4g+F7VHt3bBwUJHTbWye/FKM6
5OVZetCYKVj7Z+5BYuf7cumzvRqcn32fXidB/kjRX14SJ4JDPn2yFZWCr2ygIqWQ
SOuEmWbNAbYGaVZkQr2Ma8U28DWY2jb0f6nP8jLt49t9o6N/e6Fwd6I5t/mx9Mfj
0403omkxmr9vqN2kBamzVnun+2mDkRZcKPCr72Q4sfbvmDi/W5Nf1Iu2cQW8VfDO
SqpyT54=
-----END CERTIFICATE-----
`;
const LEAF2 = `-----BEGIN CERTIFICATE-----
MIIDuzCCAqOgAwIBAgIPAPAN+s4AESIzRFVmd4iZMA0GCSqGSIb3DQEBDAUAMIGc
MQswCQYDVQQGEwJVUzETMBEGA1UECAwKQ2FsaWZvcm5pYTEWMBQGA1UEBwwNU2Fu
IEZyYW5jaXNjbzEUMBIGA1UECgwLRXhhbXBsZSBPcmcxETAPBgNVBAsMCERldiBU
ZWFtMRgwFgYDVQQDDA9FeGFtcGxlIFJvb3QgQ0ExHTAbBgkqhkiG9w0BCQEWDmNh
QGV4YW1wbGUuY29tMB4XDTI2MTAyMTE2MzM1MloXDTM2MTAxODE2MzM1MlowJzER
MA8GA1UECgwITGVhZiBPcmcxEjAQBgNVBAMMCWxvY2FsaG9zdDBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABJVfVy9EH/VHQuRqpFFnXk0F00ncDht6APgVPDoybK8H
PlcM4T5H1yAOMHnlH29LK1jtMqU1aAOiiQRzPdCvqoujggE3MIIBMzAJBgNVHRME
AjAAMGgGA1UdEQRhMF+CCWxvY2FsaG9zdIINKi5leGFtcGxlLmNvbYcEfwAAAYcQ
AAAAAAAAAAAAAAAAAAAAAYERYWRtaW5AZXhhbXBsZS5jb22GGGh0dHBzOi8vZXhh
bXBsZS5jb20vcGF0aDBdBggrBgEFBQcBAQRRME8wIwYIKwYBBQUHMAGGF2h0dHA6
Ly9vY3NwLmV4YW1wbGUuY29tMCgGCCsGAQUFBzAChhxodHRwOi8vY2EuZXhhbXBs
ZS5jb20vY2EuY3J0MB0GA1UdJQQWMBQGCCsGAQUFBwMBBggrBgEFBQcDAjAdBgNV
HQ4EFgQUdKIx6ULFLPNP/kzwUFjSa5D19RswHwYDVR0jBBgwFoAUP+yQyItpNYEl
s26Jfv+NnciGaK8wDQYJKoZIhvcNAQEMBQADggEBABmQ8f2VsXNaMM9X1MEhi27D
LjwcOaaGEINNZq7xu/HL6UljMb1Odsuz66DkiH3Exd3MrWy6OlOpJJF0VzsqMsoD
0CRBxXF28o6Jil3vOGVwlYNmRidpkAkj4VyWDvv8FCS9VbsBtXaSHwu9wcCwePE0
cGJRfTKoZ6KJ8vQ57DBEZ/ZszuhehOZYqrTmoUdjZ123kXdxQvK+ALn4SlIXHBhN
9unhd+8i00EmkXO/REw8paMcMVVGR+ioOEjyNHqZo6vkRqgpKggn1Yq8cTTDOMnS
P1o42EQZLlbuvx0kqInBqwqjDx4nZiPaifoDc9BF6iZPBvm8dhrEfghfB1tkNk0=
-----END CERTIFICATE-----
`;
const PSS = `-----BEGIN CERTIFICATE-----
MIIDdTCCAiigAwIBAgICAIAwQgYJKoZIhvcNAQEKMDWgDzANBglghkgBZQMEAgEF
AKEcMBoGCSqGSIb3DQEBCDANBglghkgBZQMEAgEFAKIEAgIA3jAeMQwwCgYDVQQD
DANwc3MxDjAMBgNVBAoMBWN0bAF4MB4XDTI2MTAyMTE2NDQzM1oXDTI2MTEyMDE2
NDQzM1owHjEMMAoGA1UEAwwDcHNzMQ4wDAYDVQQKDAVjdGwBeDCCASIwDQYJKoZI
hvcNAQEBBQADggEPADCCAQoCggEBAL2pno8Ybwihdv3hnMhWPPt85SXQmFAJpFoS
E+sT9H6FbwFCIyPkY+SWk8H7y8V+D+388tNvJZmGjX3uvWpK2Wx6anSB3/WMpkUR
2ExP4cpSxZNr9EFzC/cdqLvsxJcHMHkc/uJuFbtjsuiH1ygOe3nyhWSNiPwGdwHE
cKkBFkzW3j2C/4Jkgt4k+sMe3gy5litKtMi4zZB8ixCm5oGhveGhUZy0Kb01twgZ
RP4FEd32sSRqq3NCx4cB0kyreTuzmk6U7BkxcdPzaj6DifjRznTQmjMdoCNZQRCj
G3KBOMHHyvmV2B4lNGDuMlcSap/TpYq7n32AH5sDvELrUnPwVzsCAwEAAaNTMFEw
HQYDVR0OBBYEFC/QJvAQsbQ25sErc1To2G1VuNZ0MB8GA1UdIwQYMBaAFC/QJvAQ
sbQ25sErc1To2G1VuNZ0MA8GA1UdEwEB/wQFMAMBAf8wQgYJKoZIhvcNAQEKMDWg
DzANBglghkgBZQMEAgEFAKEcMBoGCSqGSIb3DQEBCDANBglghkgBZQMEAgEFAKIE
AgIA3gOCAQEAu3lP2Q3Bb5fWUQtgFr/82Oke1ZRW/GRbj03mZ30izADHC7yk0OYm
02f7B5sub04Jk6yuRVmEBjJHSPNwAo0RJWtwvD77KLhG8aObr7Z3+pkfFvpGzqeS
MQ4FtK2MPps3kA1a5D4XLwkwDJtHWZVuVyXpPgxkptfLzZgrieKrpNyOKR8Pz/PO
Wlwv6bF7SXvAV8Vrd7KDvTqwQ5iq9UFhP6GeMDWezYtzLdjlvje7MhmZ96zgSY6m
qumNWOPHmiN4eoOE4M69B+0fa3WyMzubW0nVGM/sDhtS0k5zHs6Y4RLn11HolhXH
LvbvDgqtl/m5i0uHxEld+Z1uhzJscqFQRg==
-----END CERTIFICATE-----
`;
const V1 = `-----BEGIN CERTIFICATE-----
MIIBSTCB7wIUI3kYI5NpR07YqZe6RwOx22je9IowCgYIKoZIzj0EAwIwJzERMA8G
A1UECgwITGVhZiBPcmcxEjAQBgNVBAMMCWxvY2FsaG9zdDAeFw0yNjEwMjExNjMz
NTJaFw0yNjExMjAxNjMzNTJaMCcxETAPBgNVBAoMCExlYWYgT3JnMRIwEAYDVQQD
DAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASVX1cvRB/1R0Lk
aqRRZ15NBdNJ3A4begD4FTw6MmyvBz5XDOE+R9cgDjB55R9vSytY7TKlNWgDookE
cz3Qr6qLMAoGCCqGSM49BAMCA0kAMEYCIQCFfFOw9qzzfSOQO1zRnT0sOXibjLWl
hHDyqecxhY7gtQIhAPMgqg+p1JXV5bgGpqgDfP3sE53luxMGlnAC39uhwBUh
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
const PLAIN_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCq01NcNAy9Ng04
mVuAFvmZUvsmrY7aOaMgtODmptulgZ2qw25E09RgGYCn1S+4IYDu9hH9X4s+28Ag
7Khmj4nmeoXNof5095wche8DR2AAUElqyr/Nmgm2kTLdIJX4wl0eWXHIlmSPdOUN
ovA6JjGKH99b8W7a2TqY/TsSadpPSvvN2esr7Jr4KgW7MXPUOnwNbcBOVcQP9rtF
rduAWz01q0HM02LboclnUnk/e58BXAj8vgdVojljDcc0bhbdz/Hh1/5gaaNILjJN
Od4AgwZaCT02KojGz4Nb6MSgFmON2iMgAZjY1fXXkJ7wsfVPytjW73e7uV/RFuqS
HQZenxupAgMBAAECggEAAxY5ACZHoaanpAFvbBfeMEVV2PvTZEGc30MtejWDLBE0
yGhqJm++e3MShlXdnCHs2sSTDCVNFphxdxbXryzCVOobX10hRDtSNJi9+izwwOiy
fu3FfAFf0g77IJBNbXaTqK/8lJ+VFxuJZQ7v8NkOVZzgVCC/fFBnFOskhV9ozLx6
Uk+5Rg/UFenUhhHqrzwxCLKR3TAX8pBdidmbJF61ypxt6Cn3pOA/pB1gUBi76nau
w4kefdNj8AXzSjzOfVEg0quywfeoOq6ESdy3p4RQMt6NZ3wnCgzr/uuWjVQzJbJU
Mg2TVlrKzbiinel2ZqKV8lpymhFTlRaWNzK7PzD91QKBgQDaSDpdQIk2+CJMAVzU
LsI5tdZa0cMDbAZzxBmg1W6kwIrMzYVeMo7RPBarhCuQ/3gJFVvA7LdvXR87BbYa
UuDXbvO4Gv+2wqxxX961sWK85VqhwAqXhFbkS9KNJ0twmlmAcX9lvl0Zn4ciO3c+
AMJT4JN4WR6wI/dt1TCHLa1wtQKBgQDIV9bgKinpUzhSy9byTH0CwghwudAPx2CA
9gJ6VcjyUKeBdgJ0PQMTwppyrPs0fz+NgJ6+LiTvp9BS9vrXmtnjbD1oAxFcC9uU
NL7BJSRY+wgmnPgbldA25xq1TRJmB8YMr1CO4gYKGSNM7I1HlNv4dvMcS295RhTG
cdDkl4T7pQKBgQCzJmygdIMplmWvs76Ydvf5nYAcceR4PoTdJqlSE1oH5e8FP/ih
4yTMHWENzCBllQbTjbAMmzvCLs+fBYT7/eGDbxCgnagaO5SESIbk4H2FQ0grUQ5g
ZMFcBc79Aq8r78JdZMmGm8KVcRTbx6qKPN1BMiRWte416o78meiGSbr7sQKBgQCJ
2AY8TkZwB5ZlQWMva3lIAIEWLoL9mEzJ7npd+dA9CUl3Rd8CY0hOvELQTDy7LiJo
FesjJ1S6oFgx/UUyO5VXaQ4HFrVHA9Gc832cHxYXMwG0r6P2NuoAHJq/y7uxAABA
kg93gARvxkQHlWrPqZiAKDe1bCHS62k38O+tmKMjEQKBgHF7a9tqZVoc8CqUL/I8
FXRMRmdzC4RoWC2NDqMazW9qxXpFZmPux1q9ds6ikoG0v3pAxZmRH0eMTIujtLPn
chtAnvTvkg5Q+/xa429PFThJ2b04zsHCmnzfdMaIPvqhBqoPmyAmptjUeMB+yzQU
d3AigXwTBk4l4yPleDD4qUbO
-----END PRIVATE KEY-----
`;
const ED_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEID8VP7HLPAW9FXkVxo3eYbqZ8zkXsPFi3c2RwdDdwy/O
-----END PRIVATE KEY-----
`;

const certs: [string, X509Certificate][] = [
  ["root", new X509Certificate(ROOT)],
  ["leaf", new X509Certificate(Buffer.from(LEAF))],
  ["plain", new X509Certificate(PLAIN)],
  ["ed", new X509Certificate(ED)],
  ["root2", new X509Certificate(ROOT2)],
  ["leaf2", new X509Certificate(LEAF2)],
  ["pss", new X509Certificate(PSS)],
  ["v1", new X509Certificate(V1)],
];

function describe(key: KeyObject): string {
  const details = key.asymmetricKeyDetails ?? {};
  const size = key.asymmetricKeyType === "ed25519" ? "32 bytes" : `${details.modulusLength ?? details.namedCurve}`;
  return `${key.type} ${key.asymmetricKeyType} ${size}`;
}

for (const [name, cert] of certs) {
  const key = cert.publicKey;
  const spki = key.export({ type: "spki", format: "der" });
  console.log(name, describe(key), key === cert.publicKey, spki.length, createPublicKey(cert.toString()).equals(key));
}

for (const [name, cert] of certs) {
  const by: string[] = [];
  const issued: string[] = [];
  for (const [other, signer] of certs) {
    if (cert.verify(signer.publicKey)) by.push(other);
    if (cert.checkIssued(signer)) issued.push(other);
  }
  console.log(name, "verifies with", by.join(",") || "-", "issued by", issued.join(",") || "-");
}

const keys: [string, KeyObject][] = [
  ["root", createPrivateKey(ROOT_KEY)],
  ["leaf", createPrivateKey(Buffer.from(LEAF_KEY))],
  ["plain", createPrivateKey({ key: PLAIN_KEY, format: "pem" })],
  ["ed", createPrivateKey(ED_KEY)],
  ["fresh", generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey],
];
for (const [name, cert] of certs) {
  console.log(name, "private", keys.filter(([, key]) => cert.checkPrivateKey(key)).map(([k]) => k).join(",") || "-");
}

const leaf = certs[1]![1];
function attempt(label: string, f: () => boolean): void {
  try {
    console.log(label, f());
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, err.name, err.code, err.message);
  }
}
attempt("verify private", () => leaf.verify(keys[0]![1]));
attempt("verify secret", () => leaf.verify(createSecretKey(Buffer.alloc(16))));
attempt("check public", () => leaf.checkPrivateKey(leaf.publicKey));
attempt("check secret", () => leaf.checkPrivateKey(createSecretKey(Buffer.alloc(16))));

// A PSS signature check on the root's public key leaves no padding behind
// for the certificate checks that follow.
const root = certs[0]![1];
const message = Buffer.from("pss");
const pssSignature = sign("sha256", message, { key: keys[0]![1], padding: constants.RSA_PKCS1_PSS_PADDING });
const pssValid = verify("sha256", message, { key: root.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING }, pssSignature);
console.log("after pss", pssValid, root.verify(root.publicKey), leaf.verify(root.publicKey));

// An outer signatureAlgorithm that differs from the TBSCertificate's, here
// without its NULL parameters, does not verify.
function header(der: Buffer, at: number): [number, number] {
  const first = der[at + 1]!;
  if (first < 0x80) return [2, first];
  let length = 0;
  for (let i = 0; i < (first & 0x7f); i++) length = length * 256 + der[at + 2 + i]!;
  return [2 + (first & 0x7f), length];
}
const rootDer = root.raw;
const [outerHeader] = header(rootDer, 0);
const [tbsHeader, tbsLength] = header(rootDer, outerHeader);
const algAt = outerHeader + tbsHeader + tbsLength;
const [algHeader, algLength] = header(rootDer, algAt);
const algorithm = rootDer.subarray(algAt, algAt + algHeader + algLength);
const oid = algorithm.subarray(2, 2 + 2 + algorithm[3]!);
const bare = Buffer.concat([Buffer.from([0x30, oid.length]), oid]);
const body = Buffer.concat([rootDer.subarray(outerHeader, algAt), bare, rootDer.subarray(algAt + algHeader + algLength)]);
const altered = new X509Certificate(Buffer.concat([Buffer.from([0x30, 0x82, body.length >> 8, body.length & 0xff]), body]));
console.log("outer algorithm", algorithm.toString("hex"), "->", bare.toString("hex"), altered.subject.split("\n").join("/"), altered.verify(root.publicKey));
