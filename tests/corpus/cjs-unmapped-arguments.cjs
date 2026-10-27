// Sloppy-mode CommonJS functions whose parameter lists are not simple
// (defaults, destructuring) get the unmapped `arguments` object:
// writing a parameter never shows through it.
function withDefault(a, b = 2) {
  a = 'changed';
  return [a, b, arguments.length, arguments[0]].join(' ');
}

function withPattern({ x }, y) {
  y = 'changed';
  return [x, y, arguments.length, arguments[1]].join(' ');
}

function passAlong(first, { y } = {}) {
  first = 'changed';
  return collect(arguments) + ' / ' + y + ' ' + first;
}

function collect(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) out.push(String(args[i]));
  return out.join(',');
}

console.log(withDefault('orig'));
console.log(withDefault('orig', 5, 6));
console.log(withPattern({ x: 1 }, 'orig'));
console.log(passAlong('a', { y: 'b' }, 'c'));
