// Sloppy-mode functions with named parameters that read `arguments` only
// where its aliasing of the parameters cannot show: the count, and
// element reads in functions that never write a parameter or an element.
function count(a, b, c) {
  if (arguments.length < 3) {
    if (typeof b !== 'number') {
      c = b;
      b = undefined;
    }
  }
  return [arguments.length, a, b, c];
}
console.log(JSON.stringify(count('x')));
console.log(JSON.stringify(count('x', ['t'])));
console.log(JSON.stringify(count('x', 2, ['t'])));

const Options = function (host, port) {
  let options = host || {};
  if (arguments.length > 1 || typeof host === 'string') {
    options = { host: host, port: port };
  }
  this.host = options.host || 'localhost';
  this.port = options.port || 8125;
};
const a = new Options({ host: 'h1', port: 1 });
const b = new Options('h2', 2);
const c = new Options('h3');
const d = new Options();
console.log(a.host, a.port, b.host, b.port, c.host, c.port, d.host, d.port);

function pick(first, second) {
  const out = [];
  for (let i = 0; i < arguments.length; i++) out.push(arguments[i]);
  return out.join(',') + '|' + first + '|' + second;
}
console.log(pick(1), pick(1, 2), pick(1, 2, 3, 4));

const proto = {};
proto.step = function (value, by) {
  return arguments.length === 1 ? value + 1 : value + by;
};
console.log(proto.step(1), proto.step(1, 10));
