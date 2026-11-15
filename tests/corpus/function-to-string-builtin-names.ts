// Function.prototype.toString over the runtime's own functions: a builtin
// method value prints `function NAME() { [native code] }` with the name Node
// gives it, through String(), join and console.log alike.

const obj: any = { m: 1 };
console.log(String(obj.hasOwnProperty));
console.log(String(Object.prototype.hasOwnProperty));
console.log(String(obj.toString));
console.log(String(String.prototype.slice));

const arr: any = [1];
console.log(String(arr.push));
console.log(String(Array.prototype.push));

const joined: any[] = [obj.hasOwnProperty, Array.prototype.push, obj.toString];
console.log(joined.join(" | "));

console.log(Array.prototype.push);
console.log(String.prototype.slice);

const sooner: unknown = Array.prototype.push;
console.log(String(sooner));

const parse: any = Number.parseInt;
console.log(String(parse));
const jsonStringify: any = JSON.stringify;
console.log(String(jsonStringify));
const mathMax: any = Math.max;
console.log(String(mathMax));

const fnToString = obj.toString;
console.log(typeof fnToString);
