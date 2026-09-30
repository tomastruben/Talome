// Minimal reproduction of the in-app browser's iframe observer diagnostic.
// Run: node scripts/observer-isolation.mjs, then reload /fixture ten times.
// Both pages contain zero scripts. Compare with standalone Chrome.
import http from "node:http";

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1:3303").pathname;
  if (!["/fixture", "/fixture-child"].includes(pathname)) {
    response.writeHead(404).end();
    return;
  }
  const body = pathname === "/fixture"
    ? '<h1>Plain iframe fixture</h1><iframe title="One" src="/fixture-child?one"></iframe><iframe title="Two" src="/fixture-child?two"></iframe>'
    : '<h1>Plain child</h1><p>No Talome or third-party scripts.</p>';
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<!doctype html><html><head><title>Observer isolation</title></head><body>${body}</body></html>`);
});
server.listen(3303, "127.0.0.1", () => {
  console.log("Observer isolation fixture: http://127.0.0.1:3303/fixture");
});
