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
