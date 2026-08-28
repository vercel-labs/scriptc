const response = await fetch(process.argv[2]);
console.log(response.status, await response.text());
