function named(): void {}
const arrow = (): void => {};
const d: any = named;
const e: any = arrow;
console.log(d.name, "|", e.name);
