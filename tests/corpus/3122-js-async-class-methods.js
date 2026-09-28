class Source {
  value = 4;

  async doubled() {
    await Promise.resolve();
    return this.value * 2;
  }

  async *steps() {
    yield this.value;
    await Promise.resolve();
    yield this.value + 1;
  }
}

var Pair = class {
  async *values([first, second]) {
    yield first;
    yield second;
  }
};

async function main() {
  const source = new Source();
  console.log(await source.doubled());
  const steps = source.steps();
  console.log((await steps.next()).value, (await steps.next()).value, (await steps.next()).done);
  const pair = new Pair().values([7, 8]);
  console.log((await pair.next()).value, (await pair.next()).value, (await pair.next()).done);
}

void main();
