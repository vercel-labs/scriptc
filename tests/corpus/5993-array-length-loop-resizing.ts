// Index loops bounded by an array's length whose bodies resize that array,
// directly, through an alias, a helper or a closure: the bound is re-read on
// every pass, exactly like Node.

function pushInBody(): string {
  const a = [1, 2, 3];
  const seen: number[] = [];
  for (let i = 0; i < a.length; i++) {
    seen.push(a[i]);
    if (a.length < 6) a.push(a[i] * 10);
  }
  return `${seen.join(",")} | ${a.length}`;
}

function stridedPush(): string {
  const a = [0, 1, 2, 3];
  let visits = 0;
  for (let i = 0; i < a.length; i += 2) {
    visits++;
    if (a.length < 9) a.push(i);
  }
  return `${visits} ${a.join(",")}`;
}

function truncateInBody(): string {
  const a = [5, 6, 7, 8, 9, 10];
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i];
    if (i === 2) a.length = 4;
  }
  return `${sum} ${a.length}`;
}

function growLengthInBody(): string {
  const a = [1, 2];
  let holes = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === undefined) holes++;
    if (i === 0) a.length = 5;
  }
  return `${holes} ${a.length}`;
}

function helperPush(xs: number[], v: number): void {
  if (xs.length < 7) xs.push(v);
}

function pushThroughHelper(): string {
  const a = [1, 2, 3];
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i];
    helperPush(a, i + 100);
  }
  return `${sum} ${a.length}`;
}

function pushThroughClosure(): string {
  const a = [1, 2, 3];
  const grow = (v: number): void => {
    if (a.length < 6) a.push(v);
  };
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i];
    grow(i);
  }
  return `${sum} ${a.length}`;
}

function pushThroughAlias(): string {
  const a = [1, 2, 3];
  const alias = a;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i];
    if (alias.length < 8) alias.push(i * 2);
  }
  return `${sum} ${a.length}`;
}

function aliasedParameters(a: number[], out: number[]): string {
  // `out` may be `a` itself.
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    n++;
    if (out.length < 10) out.push(a[i]);
  }
  return `${n} ${a.length} ${out.length}`;
}

function writePastEnd(): string {
  const a = [1, 2, 3];
  let passes = 0;
  for (let i = 0; i < a.length; i++) {
    passes++;
    if (i + 1 === a.length && a.length < 6) a[i + 1] = i;
  }
  return `${passes} ${a.join(",")}`;
}

function shiftInBody(): string {
  const a = [1, 2, 3, 4, 5, 6];
  const seen: number[] = [];
  for (let i = 0; i < a.length; i++) {
    seen.push(a[i]);
    a.shift();
  }
  return `${seen.join(",")} | ${a.join(",")}`;
}

function spliceInDescendingLoop(): string {
  const a = [1, 2, 3, 4, 5, 6, 7];
  for (let i = a.length - 1; i >= 0; i--) if (a[i] % 2 === 0) a.splice(i, 1);
  return a.join(",");
}

function whilePush(): string {
  const a = [3, 1];
  let i = 0;
  let sum = 0;
  while (i < a.length) {
    sum += a[i];
    if (a.length < 5) a.push(sum);
    i++;
  }
  return `${sum} ${i} ${a.join(",")}`;
}

function nestedResize(): string {
  const rows = [[1], [2, 3], [4, 5, 6]];
  let total = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      total += row[c];
      if (row.length < 3) row.push(c);
    }
  }
  return `${total} ${rows.map((row) => row.length).join(",")}`;
}

function pushIntoOther(): string {
  const a = [2, 4, 6];
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) out.push(a[i] + 1);
  for (let i = 0; i < out.length; i += 2) out.push(-1);
  return `${out.join(",")}`;
}

console.log(pushInBody());
console.log(stridedPush());
console.log(truncateInBody());
console.log(growLengthInBody());
console.log(pushThroughHelper());
console.log(pushThroughClosure());
console.log(pushThroughAlias());
const shared = [7, 8, 9];
console.log(aliasedParameters(shared, shared));
console.log(aliasedParameters([7, 8, 9], []));
console.log(writePastEnd());
console.log(shiftInBody());
console.log(spliceInDescendingLoop());
console.log(whilePush());
console.log(nestedResize());
console.log(pushIntoOther());
