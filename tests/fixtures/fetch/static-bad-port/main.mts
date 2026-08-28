async function probe(label: string, url: string): Promise<void> {
  try {
    await fetch(url);
    console.log(label, "resolved");
  } catch (error) {
    const caught = error as Error;
    console.log(label, caught.name, caught.message, caught instanceof TypeError);
  }
}

await probe("direct", process.argv[2] as string);
await probe("redirect", process.argv[3] as string);
