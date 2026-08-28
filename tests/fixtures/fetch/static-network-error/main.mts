try {
  const response = await fetch(process.argv[2]);
  const status: number = response.status;
  const body: string = await response.text();
  console.log(status, body);
} catch (error) {
  const caught = error as Error;
  console.log(
    caught.name,
    caught.message,
    caught instanceof TypeError,
  );
}
