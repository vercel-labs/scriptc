// An Array subclass written through an unknown[] view: a number pushed
// through the view, and values its element type cannot hold, which the
// array keeps as written. The instance keeps its class and its fields, and
// the species results of slice and concat keep the written values.
class Scores extends Array<number> {
  label = "scores";
}

const plain = new Scores();
plain.push(1, 2);
const plainView: unknown[] = plain;
plainView.push(3);
console.log(plain instanceof Scores, plain.label, plain.length, JSON.stringify(plain));

const scores = new Scores();
scores.push(1, 2);
const view: unknown[] = scores;
view.push("x", { a: 1 });
console.log(scores instanceof Scores, scores.label, scores.length, JSON.stringify(scores), scores.join("|"));
const tail = scores.slice(1);
console.log(tail instanceof Scores, tail.length, JSON.stringify(tail));
const joined = scores.concat([9]);
console.log(joined instanceof Scores, joined.length, JSON.stringify(joined));
scores[2] = 7;
console.log(JSON.stringify(scores), view[3]);
scores.length = 1;
console.log(scores instanceof Scores, scores.label, JSON.stringify(scores), JSON.stringify(tail));
