console.log("dep");
void Promise.resolve().then(() => console.log("dep micro"));
if (false) await Promise.resolve();

export {};
