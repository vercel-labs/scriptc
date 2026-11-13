'use strict';
// RSA keys from every source form — PEM buffers, DER with an explicit type,
// KeyObjects — plus the options that convert loosely, and the key types that
// have no RSA operation at all.
const crypto = require('node:crypto');

const priv = `-----BEGIN PRIVATE KEY-----
MIICdQIBADANBgkqhkiG9w0BAQEFAASCAl8wggJbAgEAAoGBAJgQZH+E+Mi8xd6a
nEj6H62j/kx79QohEvY3+zyil/428iSnYDDFSJvj2yyGtvNfdaqTMIzG+F5uEAB/
j6l2LSoJ37EAGj/PZDo+9f2VfwAcEbqEo9doU2J4l2cySMrSeFhy7HGE7SomA8aq
o31fCNXhOwyrE1Mzs9CXFjlR+n2RAgMBAAECgYATFiunHeekOp2TfVCUkGCdiPII
Y560MMaShSBR0g7F59uo4iFevcSJXKZMBnS8Q4Ufbe4wHWFbaPE1Ps2ndZ/hb2Yv
fYz/e3q/4CU3/ECcGZH9PvIRIYugFtYgmBffGamN3s6+QT+hVdsV+QKOVDj6ZAhH
WUWswx4Ivk+tp0i8gQJBAMi3OS9rf7Pf5rnkbwNwEYw1Xyl17LZ3Qs0iv9PSFLYT
RapLu+SMIwA8MJdgzXAo3kAeOyJmCIfjQ3LhCHQNr8kCQQDB8qndnRqXjq2uHTEp
iTnOeR5Em2XCNLR5p9WLov2EQXxVlgh4bGZksV8M9SeZgDh0Jztrw9J1NDRfwor2
f5OJAkBwEiYi/SIL3Hvm1c7Km5ugrvhYnRiz9TlecwWrD0UzOOWQJcNe5IRykCkN
jSaIdrlKEdcw6Mngnhu+HDptGmtJAkBgXyki8q7FAmOw8dZ88jAkNbDhnGoK/09y
aABHe30Hm9ahXITm+c5DWJOHh8Xek4T5yojPOqW4EXG4551PcQMpAkA6a/7YzMor
LqjY5jLcv8HP8gHsxzI575e2pgq8ItyQBQeNU7Vpo8QZfXXkl5NvawJwNCSToZus
HVJSB0FQ+2sQ
-----END PRIVATE KEY-----`;

const pub = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCYEGR/hPjIvMXempxI+h+to/5M
e/UKIRL2N/s8opf+NvIkp2AwxUib49sshrbzX3WqkzCMxvhebhAAf4+pdi0qCd+x
ABo/z2Q6PvX9lX8AHBG6hKPXaFNieJdnMkjK0nhYcuxxhO0qJgPGqqN9XwjV4TsM
qxNTM7PQlxY5Ufp9kQIDAQAB
-----END PUBLIC KEY-----`;

function report(label, error) {
  console.log(
    label,
    '|',
    error.name,
    '|',
    error.code,
    '|',
    error.library,
    '|',
    error.reason,
    '|',
    error.message,
  );
}

function attempt(label, run) {
  try {
    const r = run();
    console.log(label, '| ok', r.length, r.toString('hex').slice(0, 32));
  } catch (e) {
    report(label, e);
  }
}

const msg = Buffer.from('keys from every source');
const privKey = crypto.createPrivateKey(priv);
const pubKey = crypto.createPublicKey(priv);
const privDer = privKey.export({ type: 'pkcs8', format: 'der' });
const pubDer = pubKey.export({ type: 'spki', format: 'der' });

// The key source: PEM string, PEM bytes, DER with a type, KeyObject. The
// ciphertext is random, so each case decrypts it back to the message.
attempt('pem buffer public', () =>
  crypto.privateDecrypt(priv, crypto.publicEncrypt(Buffer.from(pub), msg)),
);
attempt('pem buffer private', () =>
  crypto.privateDecrypt(Buffer.from(priv), crypto.publicEncrypt(pub, msg)),
);
attempt('der spki', () =>
  crypto.privateDecrypt(priv, crypto.publicEncrypt({ key: pubDer, format: 'der', type: 'spki' }, msg)),
);
attempt('der pkcs8', () =>
  crypto.privateDecrypt({ key: privDer, format: 'der', type: 'pkcs8' }, crypto.publicEncrypt(pub, msg)),
);
attempt('private pem as public', () => crypto.privateDecrypt(priv, crypto.publicEncrypt(priv, msg)));
attempt('keyobject option', () =>
  crypto.privateDecrypt({ key: privKey }, crypto.publicEncrypt(pubKey, msg)),
);
attempt('keyobject sha512', () =>
  crypto.privateDecrypt(
    { key: privKey, oaepHash: 'sha512' },
    crypto.publicEncrypt({ key: pubKey, oaepHash: 'sha512' }, msg),
  ),
);
attempt('passphrase unused', () =>
  crypto.privateDecrypt(priv, crypto.publicEncrypt({ key: pub, passphrase: 'x' }, msg)),
);

// oaepLabel: any view of bytes works, a string is UTF-8, anything else is
// an invalid argument. The padding value converts with ToUint32, so a
// string of digits names a padding, and an object, symbol or bigint does
// not convert at all.
const label = new Uint8Array([1, 2, 3, 4]);
attempt('label uint8', () => {
  const ct = crypto.publicEncrypt({ key: pub, oaepLabel: label }, msg);
  return crypto.privateDecrypt({ key: priv, oaepLabel: label }, ct);
});
attempt('label dataview', () => {
  const ct = crypto.publicEncrypt({ key: pub, oaepLabel: new DataView(label.buffer) }, msg);
  return crypto.privateDecrypt({ key: priv, oaepLabel: label }, ct);
});
attempt('label string', () => {
  const ct = crypto.publicEncrypt({ key: pub, oaepLabel: 'cont' }, msg);
  return crypto.privateDecrypt({ key: priv, oaepLabel: Buffer.from('cont') }, ct);
});
attempt('label number', () => crypto.publicEncrypt({ key: pub, oaepLabel: 7 }, msg));

// Ciphertext input: a string argument is taken as its UTF-8 bytes, so a hex
// spelling is twice the block size; the Buffer's own bytes are the block.
attempt('ciphertext string', () => {
  const block = Buffer.alloc(128);
  const ct = crypto.privateEncrypt({ key: priv, padding: 3 }, block);
  return crypto.publicDecrypt({ key: pub, padding: 3 }, ct.toString('hex'));
});
attempt('ciphertext buffer', () => {
  const block = Buffer.alloc(128);
  const ct = crypto.privateEncrypt({ key: priv, padding: 3 }, block);
  return crypto.publicDecrypt({ key: pub, padding: 3 }, Buffer.from(ct.toString('hex'), 'hex'));
});

attempt('padding string 1', () => {
  const ct = crypto.publicEncrypt({ key: pub, padding: '1' }, msg);
  return crypto.privateDecrypt(priv, ct);
});
attempt('padding string 0', () => crypto.publicEncrypt({ key: pub, padding: '0' }, msg));
attempt('padding true', () => {
  const ct = crypto.publicEncrypt({ key: pub, padding: true }, msg);
  return crypto.privateDecrypt(priv, ct);
});
attempt('padding 2^32+1', () =>
  crypto.privateDecrypt(
    { key: priv, padding: 1 },
    crypto.publicEncrypt({ key: pub, padding: 4294967297 }, msg),
  ),
);
attempt('padding negative', () => crypto.publicEncrypt({ key: pub, padding: -1 }, msg));
attempt('padding object', () => crypto.publicEncrypt({ key: pub, padding: {} }, msg));
attempt('padding symbol', () => crypto.publicEncrypt({ key: pub, padding: Symbol('p') }, msg));
attempt('padding bigint', () => crypto.publicEncrypt({ key: pub, padding: 1n }, msg));

// Key types with no RSA operation: an rsa-pss key, x25519 and ed25519.
const pss = crypto.generateKeyPairSync('rsa-pss', { modulusLength: 1024 });
attempt('pss encrypt', () => crypto.publicEncrypt(pss.publicKey, msg));
attempt('pss decrypt', () => crypto.privateDecrypt(pss.privateKey, msg));
attempt('pss decrypt pkcs1', () =>
  crypto.privateDecrypt({ key: pss.privateKey, padding: 1 }, Buffer.alloc(128)),
);
attempt('pss sign', () => crypto.privateEncrypt(pss.privateKey, msg));
attempt('pss sign pss', () => crypto.privateEncrypt({ key: pss.privateKey, padding: 6 }, msg));
attempt('pss recover', () => crypto.publicDecrypt(pss.publicKey, Buffer.alloc(128)));

const x = crypto.generateKeyPairSync('x25519');
attempt('x25519 encrypt', () => crypto.publicEncrypt(x.publicKey, msg));
attempt('x25519 sign', () => crypto.privateEncrypt(x.privateKey, msg));
attempt('x25519 recover', () => crypto.publicDecrypt(x.publicKey, msg));

const ed = crypto.generateKeyPairSync('ed25519');
attempt('ed25519 encrypt', () => crypto.publicEncrypt(ed.publicKey, msg));
attempt('ed25519 sign', () => crypto.privateEncrypt(ed.privateKey, msg));
attempt('ed25519 recover', () => crypto.publicDecrypt(ed.publicKey, Buffer.alloc(64)));
attempt('ed25519 keyobject public', () => crypto.createPublicKey(ed.privateKey).type);
