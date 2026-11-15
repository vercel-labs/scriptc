'use strict';
// url.Url as a JavaScript value: the legacy Url constructor parseurl takes
// once at load time (`var Url = url.Url`) and constructs per request
// (`Url !== undefined ? new Url() : {}`), plus every observable of that
// class. The constructor initializes its receiver with Node's twelve
// fields in Node's order, url.parse() results carry the same prototype,
// so `parsed instanceof Url` and `new Url() instanceof Url` hold, and the
// reflection matches Node's: own keys (length, name, prototype), the
// prototype's key order with a non-enumerable constructor, and the methods
// as the prototype's one function each.
//
// process.noDeprecation keeps the DEP0169 report from url.parse() out of
// the stderr comparison (5270-url-parse-no-deprecation.cjs pins that flag).
process.noDeprecation = true;
const url = require('url');
const { inspect } = require('util');

const log = (line) => console.log(line);
const attempt = (label, fn) => {
  try {
    const value = fn();
    log(`${label} ${value === undefined ? 'undefined' : String(value)}`);
  } catch (error) {
    log(`${label} ${error.name}: ${error.message}`);
  }
};

const Url = url.Url;

log(`typeof ${typeof Url} ${Url.name} ${Url.length}`);
log(`own ${Object.getOwnPropertyNames(Url).join(',')}`);
log(`identity ${Url === url.Url}`);
const prototypeDescriptor = Object.getOwnPropertyDescriptor(Url, 'prototype');
log(
  `prototype descriptor ${prototypeDescriptor.writable} ${prototypeDescriptor.enumerable} ` +
    `${prototypeDescriptor.configurable} ${prototypeDescriptor.value === Url.prototype}`,
);
log(`prototype own ${Object.getOwnPropertyNames(Url.prototype).join(',')}`);
const constructorDescriptor = Object.getOwnPropertyDescriptor(Url.prototype, 'constructor');
log(
  `constructor descriptor ${constructorDescriptor.value === Url} ${constructorDescriptor.writable} ` +
    `${constructorDescriptor.enumerable} ${constructorDescriptor.configurable}`,
);
log(`constructor name ${Url.prototype.constructor.name} ${Url.prototype.constructor.length}`);
log(
  `methods ${['parse', 'format', 'resolve', 'resolveObject', 'parseHost']
    .map((name) => `${name}:${Url.prototype[name].name}/${Url.prototype[name].length}`)
    .join(' ')}`,
);
log(
  `method identity ${Url.prototype.parse === Url.prototype.parse} ` +
    `${Url.prototype.format !== Url.prototype.parse} ${typeof Url.prototype.parse}`,
);
const prototypeKeys = [];
for (const key in Url.prototype) prototypeKeys.push(key);
log(`prototype forin ${prototypeKeys.join(',')}`);
log(`prototype json ${JSON.stringify(Url.prototype)}`);

const fresh = new Url();
log(`fields ${JSON.stringify(fresh)}`);
log(`keys ${Object.keys(fresh).join(',')}`);
log(`instance ${fresh instanceof Url} ${Object.getPrototypeOf(fresh) === Url.prototype}`);
log(`constructor ${fresh.constructor === Url} ${fresh.constructor.name}`);
const instanceKeys = [];
for (const key in fresh) instanceKeys.push(key);
log(`forin ${instanceKeys.join(',')}`);
log(`inspect ${inspect(fresh).replace(/\s+/g, ' ')}`);
log(`empty format ${JSON.stringify(url.format(fresh))}`);
log(`extra args ${JSON.stringify(new Url(1, 'two', { three: 3 }))}`);
log(`instance format ${JSON.stringify(fresh.format())}`);
log(`prototype format ${JSON.stringify(Url.prototype.format.call(fresh))}`);

const parsed = url.parse('http://user:pw@example.com:8080/a/b?x=1#h');
log(
  `parsed ${parsed instanceof Url} ${Object.getPrototypeOf(parsed) === Url.prototype} ` +
    `${parsed.constructor === Url}`,
);
log(`parsed href ${parsed.href}`);
const plain = url.parse('/just/a/path');
log(`plain parsed ${plain instanceof Url} ${JSON.stringify(Object.getPrototypeOf(plain) === Url.prototype)}`);

// Node's Url body runs in strict mode: a primitive receiver throws the
// quoted TypeError, nullish receivers the "Cannot set properties" one.
attempt('call number', () => Url.call(5));
attempt('call string', () => Url.call('x'));
attempt('call boolean', () => Url.call(true));
attempt('plain call', () => Url());
attempt('call null', () => Url.call(null));
attempt('call undefined', () => Url.call(undefined));
attempt('apply number', () => Url.apply(5, []));

const receiver = {};
attempt('call object', () => Url.call(receiver));
log(`receiver ${JSON.stringify(receiver)}`);
const array = [];
attempt('call array', () => Url.call(array));
log(`array fields ${JSON.stringify(array)}`);
const fn = function ignored() {};
attempt('call function', () => Url.call(fn));
log(`function field ${JSON.stringify(fn.protocol)}`);
attempt('apply object', () => Url.apply({}, []));
const chained = Object.create(Url.prototype);
attempt('call prototype instance', () => Url.call(chained));
log(`chained ${JSON.stringify(chained)} ${chained instanceof Url}`);

// parseurl 1.3.3's shapes: the load-time read, the per-request build, and
// fresh()'s instanceof guard across both kinds of parsed object.
const requests = ['/x?y=1', '/plain', '/z#frag'];
function fastParse(str) {
  const parsedUrl = Url !== undefined ? new Url() : {};
  parsedUrl.path = str;
  parsedUrl.href = str;
  return parsedUrl;
}
function isFresh(input, parsedUrl) {
  return (
    typeof parsedUrl === 'object' &&
    parsedUrl !== null &&
    (Url === undefined || parsedUrl instanceof Url) &&
    parsedUrl._raw === input
  );
}
for (const request of requests) {
  const built = fastParse(request);
  built._raw = request;
  log(`fastparse ${built.href} ${built instanceof Url} ${isFresh(request, built)} ${isFresh('/other', built)}`);
  log(`format built ${JSON.stringify(url.format(built))}`);
}
const fromParse = url.parse('/parsed?q=1');
fromParse._raw = '/parsed?q=1';
log(`fresh parsed ${isFresh('/parsed?q=1', fromParse)} ${isFresh('/no', fromParse)}`);

log(`resolve ${JSON.stringify(url.resolve('/a/b', 'c?d=1'))}`);
log(`resolved instance ${url.parse(url.resolve('/a/b', 'c')).pathname}`);
