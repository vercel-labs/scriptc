process.on("message", (m) => {
  process.send({ echo: m });
  if (m === "bye") process.disconnect();
});
