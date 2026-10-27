// Number keys that are not array indices ("-1", "1.5", "NaN", "Infinity")
// are ordinary properties of an array. Writes and reads through an untyped
// function, through a string key, and through the array itself all reach
// the same property, and key walks list them after the indices.

function put(target, key, value) {
  target[key] = value;
}
function get(target, key) {
  return target[key];
}
function has(target, key) {
  return key in target;
}
function drop(target, key) {
  delete target[key];
}

const empty = [];
empty[-1] = "x";
empty[1.5] = "y";
empty[NaN] = "z";
console.log(empty[-1], empty[1.5], empty[NaN], empty.length);
console.log(empty["-1"], empty["1.5"], empty["NaN"]);

const words = ["p", "q"];
put(words, -1, "x");
put(words, 1.5, "y");
put(words, NaN, "z");
put(words, Infinity, "inf");
console.log(get(words, -1), get(words, 1.5), get(words, NaN), get(words, Infinity));
console.log(words[-1], words[1.5], words[NaN], words[Infinity], words["-1"], words.length);
console.log(get(words, "-1"), get(words, "1.50"), get(words, "-0"), has(words, "1.5"));
console.log(Object.keys(words), JSON.stringify(words));
for (const key in words) console.log("key", key);

words[-1] = "again";
console.log(get(words, -1), words["-1"]);
put(words, "label", "named");
console.log(get(words, "label"), get(words, -1));
drop(words, -1);
console.log(words[-1], has(words, -1), get(words, 1.5));
console.log(Object.keys(words));

const numbers = [1, 2];
put(numbers, -1, 10);
put(numbers, 2.5, 20);
console.log(numbers[-1], get(numbers, -1), numbers[2.5], numbers.length);
numbers.push(3);
console.log(get(numbers, -1), numbers.join(","));
