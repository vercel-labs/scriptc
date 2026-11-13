// @normalize-pid
// A CryptoKey handed to node:crypto reports DEP0203 through
// process.emitWarning, so a replacement sees the message, type and code at
// the call that first converts the key, and no later call reports again.
// The report is spent by that first call even when the replacement throws.
'use strict';
const crypto = require('node:crypto');

const iv = Buffer.alloc(16, 1);

function attempt(label, run) {
  try {
    console.log(label, 'ok', run());
  } catch (e) {
    console.log(label, 'threw', e.name, e.code, '|', e.message);
  }
}

async function main() {
  const secret = await crypto.subtle.importKey('raw', Buffer.alloc(16, 2), 'AES-CBC', false, ['encrypt']);
  const hmacSecret = await crypto.subtle.importKey(
    'raw',
    Buffer.from('hmac bytes'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );

  const calls = [];
  process.emitWarning = (...args) => {
    calls.push(args);
  };

  console.log('before cipher');
  const cipher = crypto.createCipheriv('aes-128-cbc', secret, iv);
  console.log('after cipher', typeof cipher);
  cipher.update('plaintext');
  cipher.final();
  console.log('reports', calls.length);
  console.log('report kind', calls[0].length, typeof calls[0][0], calls[0][1], calls[0][2]);
  console.log('report text', calls[0][0]);

  console.log('hmac', crypto.createHmac('sha256', hmacSecret).update('x').digest('hex'));
  console.log('reports after hmac', calls.length);

  attempt('public key', () => crypto.createCipheriv('aes-128-cbc', pair.publicKey, iv));
  console.log('reports after public key', calls.length);

  process.emitWarning = () => {
    throw new Error('warning refused');
  };
  const second = await crypto.subtle.importKey('raw', Buffer.alloc(16, 3), 'AES-CBC', false, ['encrypt']);
  attempt('throwing replacement', () => {
    crypto.createCipheriv('aes-128-cbc', second, iv);
    return 'created';
  });
}

main();
