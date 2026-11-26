# Fixture certificates

Minted ONCE with the openssl recipe below (see san.cnf) and committed with a 100-year validity so the differential lanes never depend on a system trust store or re-minting. `ca.pem` signs `localhost.pem` (SAN: DNS:localhost, IP:127.0.0.1, IP:::1); `ca2.pem` is a deliberately WRONG trust anchor for negative cases; `selfsigned.pem` is a self-signed localhost leaf for the "self-signed certificate" error shapes. All keys are throwaway P-256 test material — nothing here is a secret.

    openssl ecparam -genkey -name prime256v1 -noout -out ca-key.pem
    openssl req -new -x509 -key ca-key.pem -out ca.pem -days 36500 -subj "/CN=scriptc test CA" -config san.cnf -extensions caext
    openssl ecparam -genkey -name prime256v1 -noout -out localhost-key.pem
    openssl req -new -key localhost-key.pem -out leaf.csr -subj "/CN=localhost" -config san.cnf
    openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out localhost.pem -days 36500 -extfile san.cnf -extensions ext
    openssl ecparam -genkey -name prime256v1 -noout -out selfsigned-key.pem
    openssl req -new -x509 -key selfsigned-key.pem -out selfsigned.pem -days 36500 -subj "/CN=localhost" -config san.cnf -extensions ext

(ca2 repeats the ca recipe with its own key and CN.)

`alt.pem`/`alt-key.pem` (the SNI fixtures' second identity: CN=alt.localhost, SAN DNS:alt.localhost) repeats the leaf recipe against the same `ca.pem`, with an ext section whose subjectAltName is `DNS:alt.localhost`.

`localhost-rsa.pem`/`localhost-rsa-key.pem` is a second localhost leaf with the same subject and SAN whose key is RSA 2048, signed by `ca.pem`, for the cipher suites that authenticate with RSA (the finite-field Diffie-Hellman suites have no ECDSA form):

    openssl genrsa -traditional -out localhost-rsa-key.pem 2048
    openssl req -new -key localhost-rsa-key.pem -out rsa.csr -subj "/CN=localhost" -config san.cnf
    openssl x509 -req -in rsa.csr -CA ca.pem -CAkey ca-key.pem -set_serial 4243 -out localhost-rsa.pem -days 36500 -extfile san.cnf -extensions ext

`client.pem`/`client-key.pem` (CN=scriptc test client) is a client certificate for the mutual-TLS fixtures: a P-256 leaf signed by `ca.pem` whose extended key usage is clientAuth (`client.cnf`, section `ext`):

    openssl ecparam -genkey -name prime256v1 -noout -out client-key.pem
    openssl req -new -key client-key.pem -out client.csr -subj "/CN=scriptc test client" -config client.cnf
    openssl x509 -req -in client.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out client.pem -days 36500 -extfile client.cnf -extensions ext

`embedded.pem`/`embedded-key.pem` (CN=embedded pem) is a localhost leaf signed by `ca.pem` whose Netscape comment extension holds `alt.pem` as PEM text on one line (`embedded.cnf`, section `ext`). It checks that a peer certificate's DER is read as DER:

    openssl ecparam -genkey -name prime256v1 -noout -out embedded-key.pem
    openssl req -new -key embedded-key.pem -out embedded.csr -subj "/CN=embedded pem" -config embedded.cnf
    openssl x509 -req -in embedded.csr -CA ca.pem -CAkey ca-key.pem -set_serial 4242 -out embedded.pem -days 36500 -extfile embedded.cnf -extensions ext

`crl-leaf.pem`/`crl-leaf-key.pem` is a localhost leaf signed by `ca.pem` through the `openssl ca` database, and the `crl-*.pem` files are CRLs for that CA (one per verification outcome) plus `crl-untrusted.pem`, a CRL signed by `ca2.pem`. They are minted in a throwaway CA directory that copies `ca.pem`/`ca-key.pem`, so the committed `ca.srl` is untouched:

    mkdir -p ca-db/newcerts && cp ca.pem ca-key.pem ca-db/
    : > ca-db/index.txt && echo 1000 > ca-db/serial && echo 1000 > ca-db/crlnumber
    # ca-db/ca.cnf: database/new_certs_dir/certificate/private_key/serial/crlnumber point at ca-db,
    # x509_extensions=leaf_ext (localhost SAN, serverAuth), crl_extensions=crl_ext
    openssl ecparam -genkey -name prime256v1 -noout -out crl-leaf-key.pem
    openssl req -new -key crl-leaf-key.pem -subj "/CN=localhost" -out crl-leaf.csr
    openssl ca -batch -config ca-db/ca.cnf -in crl-leaf.csr -out crl-leaf.pem -notext
    openssl ca -config ca-db/ca.cnf -revoke crl-leaf.pem
    openssl ca -config ca-db/ca.cnf -gencrl -crl_lastupdate 20200101000000Z -crl_nextupdate 20300101000000Z -out crl-revoked.pem
    openssl ca -config ca-db/ca.cnf -gencrl -crl_lastupdate 20200101000000Z -crl_nextupdate 20210101000000Z -out crl-expired.pem
    openssl ca -config ca-db/ca.cnf -gencrl -crl_lastupdate 20270101000000Z -crl_nextupdate 20370101000000Z -out crl-future.pem
    openssl ca -config ca-db/ca.cnf -gencrl -out crl-badsig.pem   # then flip one signature byte, as with badsig.pem
    # crl-untrusted.pem repeats -gencrl in a second ca-db directory that copies ca2.pem/ca2-key.pem

`crl-clean.pem` is the same valid-window CRL from a copy of the CA database with the revocation entry removed: an empty list, so the leaf verifies.

`int-ca.pem`/`int-ca-key.pem`, `int-leaf.pem`/`int-leaf-key.pem` and the `int-*crl*.pem` files are the intermediate-chain CRL fixtures: a CA certificate signed by `ca.pem`, a localhost leaf signed by that intermediate, a root-issued CRL that revokes the intermediate (`int-crl-revoked.pem`) and its clean counterpart, plus a clean CRL issued by the intermediate for its leaf (`int-leaf-crl-clean.pem`). They are minted with `openssl ca` in throwaway CA directories that copy the fixture keys:

    # root CA directory (copies ca.pem/ca-key.pem); issue int-ca with CA:TRUE, then:
    openssl ca -config root-db/ca.cnf -gencrl -out int-crl-clean.pem
    openssl ca -config root-db/ca.cnf -revoke int-ca.pem
    openssl ca -config root-db/ca.cnf -gencrl -out int-crl-revoked.pem
    # intermediate CA directory (copies int-ca.pem/int-ca-key.pem); no revocations:
    openssl ca -config int-db/ca.cnf -gencrl -out int-leaf-crl-clean.pem

`int-leaf.pem` is signed by `int-ca.pem` for CN=localhost with the usual SANs. `ca.srl` is untouched (the databases live in copies).

`crl-root-revoked.pem` is the root CA's CRL with `ca.pem` itself revoked, for the case OpenSSL also checks: the whole chain includes the trusted root, so a CRL the root issued can revoke the root. It comes from the root CA directory above, whose database holds one entry for `ca.pem`:

    openssl ca -batch -config root-db/ca.cnf -revoke ca.pem
    openssl ca -batch -config root-db/ca.cnf -gencrl -crl_lastupdate 20200101000000Z -crl_nextupdate 20300101000000Z -out crl-root-revoked.pem

`decoy-int.pem` is a self-issued certificate with the intermediate's subject and public key but its own serial, to append to a peer's presented chain: verification never uses it, so a CRL check that walked the presented list instead of the verified chain would let it stand in for the intermediate and hide the root-issued revocation. It is minted from the committed (throwaway) intermediate key, which is what a peer with the intermediate's public key can construct:

    openssl req -new -x509 -key int-ca-key.pem -subj "/CN=scriptc test intermediate CA" -days 3650 -out decoy-int.pem

`expired.pem`/`expired-key.pem` is a self-signed localhost certificate whose validity window ended on 2021-01-01, for the CERT_HAS_EXPIRED shape: a client that trusts it through `ca` still fails verification because it has expired.

    openssl ecparam -genkey -name prime256v1 -noout -out expired-key.pem
    openssl req -new -x509 -key expired-key.pem -out expired.pem -subj "/CN=localhost" -config san.cnf -extensions ext -not_before 20200101000000Z -not_after 20210101000000Z
`future.pem`/`future-key.pem` is a self-signed localhost certificate whose validity starts in 2027, for the CERT_NOT_YET_VALID shape: a client that trusts it through `ca` still fails verification because the window has not begun. The date is fixed, so the differential lane passes until 2037 and then starts failing like any expired fixture would:

    openssl ecparam -genkey -name prime256v1 -noout -out future-key.pem
    openssl req -new -x509 -key future-key.pem -out future.pem -subj "/CN=localhost" -config san.cnf -extensions ext -not_before 20270101000000Z -not_after 20370101000000Z

`badsig.pem` is `localhost.pem` with one byte of its signature flipped, keeping the issuer name and key. A client trusting `ca.pem` finds the issuer but the signature over the TBS does not verify: the CERT_SIGNATURE_FAILURE shape. `badsig-key.pem` is a copy of `localhost-key.pem` (the public key is untouched; the server only needs the pair to load):

    python3 - <<'PY'
    import base64
    s = open("localhost.pem").read()
    der = bytearray(base64.b64decode("".join(s.strip().splitlines()[1:-1])))
    der[-5] ^= 0xFF
    b = base64.b64encode(bytes(der)).decode()
    open("badsig.pem", "w").write("-----BEGIN CERTIFICATE-----\n" + "\n".join(b[i:i+64] for i in range(0, len(b), 64)) + "\n-----END CERTIFICATE-----\n")
    PY
    cp localhost-key.pem badsig-key.pem

`rootpl.pem`/`rootpl-key.pem`, `intpl.pem`/`intpl-key.pem` and `leafpl.pem`/`leafpl-key.pem` are the PATH_LENGTH_EXCEEDED chain: a root whose basicConstraints carries `pathlen:0`, a CA intermediate signed by it, and a localhost leaf signed by the intermediate. Verification fails at the root's path length constraint, which the client sees as PATH_LENGTH_EXCEEDED:

    openssl ecparam -genkey -name prime256v1 -noout -out rootpl-key.pem
    openssl req -new -x509 -key rootpl-key.pem -out rootpl.pem -days 3650 -config rootpl.cnf -extensions v3_ca
    openssl ecparam -genkey -name prime256v1 -noout -out intpl-key.pem
    openssl req -new -key intpl-key.pem -out intpl.csr -config intpl.cnf
    openssl x509 -req -in intpl.csr -CA rootpl.pem -CAkey rootpl-key.pem -CAcreateserial -out intpl.pem -days 3650 -extfile intpl.cnf -extensions v3_ca
    openssl ecparam -genkey -name prime256v1 -noout -out leafpl-key.pem
    openssl req -new -key leafpl-key.pem -subj "/CN=localhost" -out leafpl.csr
    openssl x509 -req -in leafpl.csr -CA intpl.pem -CAkey intpl-key.pem -CAcreateserial -out leafpl.pem -days 3650 -extfile san.cnf -extensions ext

(`rootpl.cnf` and `intpl.cnf` carry `basicConstraints=critical,CA:TRUE,pathlen:0` and `keyUsage=critical,keyCertSign,cRLSign`.)

`long-san.pem`/`long-san-key.pem` is a self-signed localhost certificate with a very long URI subjectAltName (600 characters), minted with `openssl req -x509 ... -addext "subjectAltName=DNS:localhost,URI:https://example.com/<600 a's>"`. It exercises rendering and reporting of a SAN longer than any fixed stack buffer.
