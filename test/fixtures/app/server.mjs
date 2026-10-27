// A tiny app for the bootstrap tests: one page with text, optionally sending "/" to a login page.
import { createServer } from "node:http";

const port = Number(process.argv[2]);
const toLogin = process.env.FIXTURE_LOGIN_REDIRECT === "1";
createServer((req, res) => {
  if (req.url === "/" && toLogin) {
    res.writeHead(302, { location: "/login" });
    return res.end();
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<html><body><h1>${req.url === "/login" ? "로그인" : "오늘 주문"}</h1></body></html>`);
}).listen(port, "127.0.0.1");
