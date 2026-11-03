const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fetch = require("node-fetch");
const { abortOnStall } = require("../src/js/providers/xtreamProvider");

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/xmltv.php`, server };
}

async function readAll(url, stallMs) {
  const controller = new AbortController();
  const resp = await fetch(url, { timeout: 5000, signal: controller.signal });
  let text = "";
  for await (const chunk of abortOnStall(resp.body, controller, stallMs)) text += chunk;
  return text;
}

test("a guide download that stalls mid-body is aborted", async () => {
  const { url, server } = await serve((req, res) => {
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.write("<tv><programme");
  });
  try {
    const started = Date.now();
    await assert.rejects(readAll(url, 100), { name: "AbortError" });
    assert.ok(Date.now() - started < 2000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("a slow guide download that keeps sending is read to the end", async () => {
  const parts = ["<tv>", "<programme/>", "<programme/>", "</tv>"];
  const { url, server } = await serve((req, res) => {
    res.writeHead(200, { "Content-Type": "application/xml" });
    let i = 0;
    const timer = setInterval(() => {
      res.write(parts[i++]);
      if (i === parts.length) {
        clearInterval(timer);
        res.end();
      }
    }, 60);
  });
  try {
    assert.strictEqual(await readAll(url, 150), parts.join(""));
  } finally {
    server.close();
  }
});
