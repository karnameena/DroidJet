const TelegramBot = require("node-telegram-bot-api");
const WebSocket = require("ws");
const http = require("http");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_CHAT_ID = Number(process.env.ALLOWED_CHAT_ID);

const PORT = process.env.PORT || 3001;

if (!TELEGRAM_TOKEN || !ALLOWED_CHAT_ID) {
  throw new Error("Missing TELEGRAM_TOKEN or ALLOWED_CHAT_ID");
}

const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: true
});

const server = http.createServer((req, res) => {
  if (req.url === "/status") {
    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(JSON.stringify({
      status: "ok",
      uptime: Math.round(process.uptime())
    }));

    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

const wss = new WebSocket.Server({
  server
});

wss.on("connection", (ws) => {
  console.log("Android client connected");

  ws.send(JSON.stringify({
    type: "server_status",
    status: "connected"
  }));

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());

      console.log("Client:", message);

      if (message.type === "status") {
        bot.sendMessage(
          ALLOWED_CHAT_ID,
          `📱 Device Status\n\n${message.status || "Unknown"}`
        );
      }
    } catch (error) {
      console.error("Invalid message:", error.message);
    }
  });

  ws.on("close", () => {
    console.log("Android client disconnected");
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error.message);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP server running on port ${PORT}`);
  console.log("WebSocket server ready");
});

bot.onText(/^\/start$/, (msg) => {
  if (Number(msg.chat.id) !== ALLOWED_CHAT_ID) {
    return bot.sendMessage(msg.chat.id, "⛔ Permission denied.");
  }

  bot.sendMessage(
    msg.chat.id,
    "🤖 DroidJet\n\nServer is online."
  );
});

console.log("Telegram bot started");
