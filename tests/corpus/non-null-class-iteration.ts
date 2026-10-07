class Alpha { read(): string { return 'a'; } }
class Beta { read(): string { return 'b'; } }
const values: (Alpha | Beta | undefined)[] = [new Alpha(), new Beta()];
for (let i = 0; i < values.length; i++) { const value = values[i]; console.log(value!.read()); }
