// A program that declares an Array subclass makes every Array method call
// stage its receiver for ArraySpeciesCreate. An unchecked `concat` whose
// result types as checked-dynamic (mixed element types) falls back to the
// dynamic call, which boxes that staged receiver. The staged local has to be
// initialized before the box: a null receiver reaches scr_arr_retain_v and
// crashes the process at module init.
class Holder extends Array {}

var node = "n";
var r = [node, "x"].concat([node, 0]);
console.log(r.length, r[0], r[2], r[3]);
