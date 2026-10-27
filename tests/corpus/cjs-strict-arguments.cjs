// `arguments` as a value in CommonJS functions with parameters where Node
// gives the unmapped object: a 'use strict' file prologue (undici's
// webidl.argumentLengthCheck(arguments, 1, name) idiom) and non-simple
// parameter lists. The object's elements never alias the parameters.
'use strict';

function argumentLengthCheck(args, min, ctx) {
  if (args.length < min) {
    throw new TypeError(`${ctx}: ${min} argument${min === 1 ? '' : 's'} required, but only ${args.length} present.`);
  }
}

function getCookies(headers) {
  argumentLengthCheck(arguments, 1, 'getCookies');
  return 'cookies of ' + headers;
}

function setCookie(headers, cookie) {
  argumentLengthCheck(arguments, 2, 'setCookie');
  headers = headers + '!';
  return headers + ' ' + cookie + ' ' + arguments[0];
}

function count(first, second) {
  const args = arguments;
  let total = 0;
  for (let i = 0; i < args.length; i++) total += args[i];
  return first + ':' + second + ':' + total;
}

console.log(getCookies('h1'));
console.log(setCookie('h2', 'c=1'));
try {
  getCookies();
} catch (err) {
  console.log(err.name, err.message);
}
try {
  setCookie('only');
} catch (err) {
  console.log(err.message);
}
console.log(count(1, 2), count(1, 2, 3, 4), count(5));
