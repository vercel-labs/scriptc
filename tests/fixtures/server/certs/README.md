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
