function reverse(value: unknown): void {
  const view = value as unknown[];
  view.reverse();
}

const pair: [number, number] = [1, 2];
reverse(pair);
console.log(pair[0], pair[1]);
