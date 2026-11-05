// A class that extends Array: construction (one number argument sets the
// length, other arguments become the elements), length and index writes,
// Array.isArray, instanceof, constructor, inherited methods, the subclass's
// own fields and methods, and how console.log and JSON show the instance.
class Stack extends Array<number> {
  pushes = 0;

  top(): number | undefined {
    return this[this.length - 1];
  }

  add(value: number): this {
    this.push(value);
    this.pushes++;
    return this;
  }
}

const s = new Stack();
s.add(1).add(2).add(3);
console.log(s.length, s.top(), s.pushes);
console.log(Array.isArray(s), s instanceof Stack, s instanceof Array, s.constructor === Stack);
console.log(s);
console.log(JSON.stringify(s));
s[5] = 9;
console.log(s.length, s[4], s);
s.length = 2;
console.log(s, s.indexOf(2), s.includes(3), s.join("-"));
s.reverse();
console.log(s.top(), s);

const sized = new Stack(3);
console.log(sized.length, sized, 0 in sized);
const listed = new Stack(4, 5);
console.log(listed.length, listed);

try {
  new Stack(-1);
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}

for (const v of listed) console.log("item", v);
console.log([...listed, 6], Object.keys(listed));
