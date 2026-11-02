# Blocked-SPKI fixture certificates

Minted ONCE with the openssl recipe below and committed with a 100-year validity, so the recorded expectations never depend on a clock or a system trust store.

The chain is `localhost.pem` → `inter.pem` → `root.pem`; `client.pem` is a second leaf of that chain (clientAuth) and `unrelated.pem` is a self-signed certificate the chain never contains. A second chain, `localhost2.pem` → `inter2.pem` → `i2.pem` → `root.pem`, reaches the root one CA further, so a client that trusts all three intermediate certificates exercises the certificates Node adds past the one mbedTLS stops at. All keys are throwaway P-256 test material — nothing here is a secret.

    openssl ecparam -genkey -name prime256v1 -noout -out root-key.pem
    openssl req -new -x509 -key root-key.pem -out root.pem -days 36500 \
        -subj "/CN=scriptc spki test root" -config san.cnf -extensions caext
    openssl ecparam -genkey -name prime256v1 -noout -out inter-key.pem
    openssl req -new -key inter-key.pem -out inter.csr \
        -subj "/CN=scriptc spki test intermediate" -config san.cnf
    openssl x509 -req -in inter.csr -CA root.pem -CAkey root-key.pem \
        -CAcreateserial -out inter.pem -days 36500 -extfile san.cnf \
        -extensions interext
    openssl ecparam -genkey -name prime256v1 -noout -out localhost-key.pem
    openssl req -new -key localhost-key.pem -out localhost.csr \
        -subj "/CN=localhost" -config san.cnf
    openssl x509 -req -in localhost.csr -CA inter.pem -CAkey inter-key.pem \
        -CAcreateserial -out localhost.pem -days 36500 -extfile san.cnf \
        -extensions leafext
    openssl ecparam -genkey -name prime256v1 -noout -out client-key.pem
    openssl req -new -key client-key.pem -out client.csr \
        -subj "/CN=scriptc spki test client" -config san.cnf
    openssl x509 -req -in client.csr -CA inter.pem -CAkey inter-key.pem \
        -CAcreateserial -out client.pem -days 36500 -extfile san.cnf \
        -extensions leafext
    openssl ecparam -genkey -name prime256v1 -noout -out unrelated-key.pem
    openssl req -new -x509 -key unrelated-key.pem -out unrelated.pem \
        -days 36500 -subj "/CN=scriptc spki test unrelated" -config san.cnf \
        -extensions caext
    openssl ecparam -genkey -name prime256v1 -noout -out i2-key.pem
    openssl req -new -key i2-key.pem -out i2.csr \
        -subj "/CN=scriptc spki test outer ca" -config san.cnf
    openssl x509 -req -in i2.csr -CA root.pem -CAkey root-key.pem \
        -CAcreateserial -out i2.pem -days 36500 -extfile san.cnf \
        -extensions caext
    openssl ecparam -genkey -name prime256v1 -noout -out inter2-key.pem
    openssl req -new -key inter2-key.pem -out inter2.csr \
        -subj "/CN=scriptc spki test inner intermediate" -config san.cnf
    openssl x509 -req -in inter2.csr -CA i2.pem -CAkey i2-key.pem \
        -CAcreateserial -out inter2.pem -days 36500 -extfile san.cnf \
        -extensions interext
    openssl ecparam -genkey -name prime256v1 -noout -out localhost2-key.pem
    openssl req -new -key localhost2-key.pem -out localhost2.csr \
        -subj "/CN=localhost" -config san.cnf
    openssl x509 -req -in localhost2.csr -CA inter2.pem -CAkey inter2-key.pem \
        -CAcreateserial -out localhost2.pem -days 36500 -extfile san.cnf \
        -extensions leafext

## Recordings

Node 24.22.1 is the only release the fixture can be recorded against: it is where `kBlockedSPKIs` (src/crypto/crypto_context.cc) landed, together with the `addBlockedSPKIForTesting` hook in `node:internal/test/binding`.

`expected/*.txt` is `main.ts`'s stdout under that release, one file per injected public key, written by `node-24.22.1/bin/node tests/fixtures/tls-spki/record.mjs` run from the repository root. A run blocks no key or the SPKI SHA-256 of one fixture certificate; `node-hook.cjs` adds it on the Node side and `SCRIPTC_TLS_BLOCKED_SPKI` carries the same digest to the native runtime. Re-record them only against a Node that applies the same policy.
