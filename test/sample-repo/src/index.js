import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

export async function loadConfig(path) {
  const data = await readFile(path, "utf-8");
  return JSON.parse(data);
}

export function startServer(port) {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200);
      res.end("ok");
      return;
    }

    if (req.url === "/data") {
      fetchData()
        .then((d) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(d));
        })
        .catch(() => {
          res.writeHead(500);
          res.end("error");
        });
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  server.listen(port);
  return server;
}

async function fetchData() {
  const resp = await fetch("https://api.example.com/data");
  const json = await resp.json();
  return json;
}
