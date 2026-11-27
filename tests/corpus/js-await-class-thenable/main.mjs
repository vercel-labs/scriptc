class Later {
  constructor(value) {
    this.value = value;
  }
  then(resolve) {
    setTimeout(() => resolve(this.value), 1);
  }
}

async function main() {
  const value = await new Later(41);
  console.log(value + 1);
}

main();
