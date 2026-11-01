# Blocked-SPKI fixture certificates

Minted ONCE with the openssl recipe below and committed with a 100-year validity, so the recorded expectations never depend on a clock or a system trust store.

The chain is `localhost.pem` → `inter.pem` → `root.pem`; `client.pem` is a second leaf of that chain (clientAuth) and `unrelated.pem` is a self-signed certificate the chain never contains. All keys are throwaway P-256 test material — nothing here is a secret.

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

## Recordings

Node 24.22.1 is the only release the fixture can be recorded against: it is where `kBlockedSPKIs` (src/crypto/crypto_context.cc) landed, together with the `addBlockedSPKIForTesting` hook in `node:internal/test/binding`.

`expected/*.txt` is `main.ts`'s stdout under that release, one file per injected public key, written by `node-24.22.1/bin/node tests/fixtures/tls-spki/record.mjs` run from the repository root. A run blocks no key or the SPKI SHA-256 of one fixture certificate; `node-hook.cjs` adds it on the Node side and `SCRIPTC_TLS_BLOCKED_SPKI` carries the same digest to the native runtime. Re-record them only against a Node that applies the same policy.
