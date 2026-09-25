// Loaded with `node --import` in test/cli.test.mjs: sends the Jev calls of the packaged configs'
// channels (api.typesafe.ai and openrouter.ai) to the local mock that FAKE_JEV_URL names, so
// `jev-router setup` can check a key against a packaged config without the network.
const target = process.env.FAKE_JEV_URL;
if (target) {
  const real = globalThis.fetch;
  /**
   * @param {string | URL | Request} input
   * @param {RequestInit} [init]
   */
  const redirected = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return real(url.replace(/^https:\/\/(api\.typesafe\.ai|openrouter\.ai\/api)(?=\/)/, target), init);
  };
  globalThis.fetch = redirected;
}
