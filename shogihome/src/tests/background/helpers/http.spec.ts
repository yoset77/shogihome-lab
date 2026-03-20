import http from "node:http";
import { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import { fetch } from "@/background/helpers/http.js";

describe("helpsers/http", () => {
  it("fetch/utf8", async () => {
    const data = await fs.readFile("./src/tests/testdata/http/utf8.txt");
    const server = http.createServer((req, res) => {
      if (req.url === "/foo/bar.baz") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(data);
      }
    });
    try {
      server.listen(0);
      const port = (server.address() as AddressInfo).port;
      const result = await fetch(`http://localhost:${port}/foo/bar.baz`);
      expect(result).toBe("ハロー、ワールド!");
    } finally {
      server.close();
    }
  });

  it("fetch/sjis", async () => {
    const data = await fs.readFile("./src/tests/testdata/http/sjis.txt");
    const server = http.createServer((req, res) => {
      if (req.url === "/foo/bar.baz") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=Shift_JIS" });
        res.end(data);
      }
    });
    try {
      server.listen(0);
      const port = (server.address() as AddressInfo).port;
      const result = await fetch(`http://localhost:${port}/foo/bar.baz`);
      expect(result).toBe("ハロー、Shift_JIS!");
    } finally {
      server.close();
    }
  });

  it("fetch/tooLarge", async () => {
    const data = Buffer.alloc(11 * 1024 * 1024); // 11 MB
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.write(data);
      res.end();
    });
    try {
      server.listen(0);
      const port = (server.address() as AddressInfo).port;
      await expect(fetch(`http://localhost:${port}/`)).rejects.toThrow("response too large");
    } finally {
      server.close();
    }
  });
});
