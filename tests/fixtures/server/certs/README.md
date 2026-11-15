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
