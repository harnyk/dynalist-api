// Add 3-second pause between test suite runs to avoid rate limiting
afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 3000));
});