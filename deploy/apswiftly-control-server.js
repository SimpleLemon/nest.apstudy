const http = require("http");

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function authorize(req, token) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return Boolean(match && match[1] === token);
}

async function runAwaitedCommand(client, name) {
  const Interpreter = require("aoi.js/src/core/interpreter.js");
  const cmd = client.cmd.awaited.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (!cmd) {
    throw new Error(`Awaited command not found: ${name}`);
  }

  const channel = client.channels?.cache?.find((entry) => entry.isTextBased?.()) || null;
  const message = {
    channel,
    guild: channel?.guild || null,
    author: client.user,
    member: null,
    mentions: { users: new Map() },
  };

  await Interpreter(client, message, [], cmd, client.db, false, undefined, {});
}

function startControlServer(client) {
  const token = (process.env.APSWIFTLY_CONTROL_TOKEN || "").trim();
  const port = Number(process.env.APSWIFTLY_CONTROL_PORT || 3921);
  const host = process.env.APSWIFTLY_CONTROL_HOST || "127.0.0.1";
  const startedAt = Date.now();

  if (!token) {
    console.warn("[APSwiftly Control] APSWIFTLY_CONTROL_TOKEN not set; control server disabled.");
    return null;
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!authorize(req, token)) {
        return sendJson(res, 401, { success: false, error: "Unauthorized" });
      }

      const url = new URL(req.url || "/", `http://${host}`);
      const path = url.pathname;

      if (req.method === "GET" && path === "/api/control/status") {
        return sendJson(res, 200, {
          ok: true,
          uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
          service: "apswiftly",
          loader_ready: Boolean(client.loader),
        });
      }

      if (req.method !== "POST") {
        return sendJson(res, 405, { success: false, error: "Method not allowed" });
      }

      await readBody(req).catch(() => "");

      if (path === "/api/control/reload") {
        if (!client.loader) {
          return sendJson(res, 500, { success: false, error: "Command loader is not initialized." });
        }
        await client.loader.update(false);
        return sendJson(res, 200, { success: true, message: "Commands hot-reloaded successfully." });
      }

      if (path === "/api/control/refresh-slash") {
        const table = client.db?.tables?.[0] || "main";
        if (client.db?.set) {
          await client.db.set(table, "isuserappsalreadysetup", undefined, "no");
        }
        await runAwaitedCommand(client, "createuserapps");
        return sendJson(res, 200, { success: true, message: "Global slash commands re-registered." });
      }

      if (path === "/api/control/shutdown") {
        sendJson(res, 200, { success: true, message: "Bot process shutting down..." });
        setTimeout(async () => {
          try {
            await client.destroy();
          } finally {
            process.exit(0);
          }
        }, 500);
        return;
      }

      return sendJson(res, 404, { success: false, error: "Not found" });
    } catch (err) {
      console.error("[APSwiftly Control] Request failed:", err);
      return sendJson(res, 500, { success: false, error: err.message || "Internal server error" });
    }
  });

  server.listen(port, host, () => {
    console.log(`[APSwiftly Control] Listening on http://${host}:${port}`);
  });

  return server;
}

module.exports = { startControlServer };
