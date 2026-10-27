// Number.parseInt / Number.parseFloat over checked-dynamic values apply
// the parsers' own ToString, as supports-color does with FORCE_COLOR.
const env = JSON.parse('{"FORCE_COLOR":"2","DEPTH":" 3.5px","EMPTY":"","HEX":"ff"}');
console.log(Number.parseInt(env.FORCE_COLOR, 10), Math.min(Number.parseInt(env.FORCE_COLOR, 10), 3));
console.log(Number.parseInt(env.MISSING, 10), Number.parseInt(env.EMPTY, 10), Number.parseInt(env.HEX, 16));
console.log(Number.parseFloat(env.DEPTH), Number.parseFloat(env.MISSING));
const values = JSON.parse("[12, true, null]");
console.log(Number.parseInt(values[0], 10), Number.parseInt(values[1], 36), Number.parseInt(values[2], 36));
