const response = await fetch(`${process.argv[2]}/text`);
const status: number = response.status;
const body: string = await response.text();
console.log(status, body);
