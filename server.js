// Aiperi Wear WhatsApp assistant
// Flow: WhatsApp message -> read live Google Sheet -> ask OpenAI -> reply on WhatsApp

const express = require("express");
const crypto = require("crypto");
const { parse } = require("csv-parse/sync");

// ---------- Settings (set these as Environment Variables on Render) ----------
const {
  VERIFY_TOKEN, // any word you choose; you type the same word into Meta
  WHATSAPP_TOKEN, // permanent access token from Meta
  PHONE_NUMBER_ID, // WhatsApp phone number ID from Meta
  OPENAI_API_KEY,
  SHEET_ID, // the long ID inside your Google Sheet link
  APP_SECRET, // optional: Meta App Secret, verifies requests really come from Meta
  OWNER_PHONE, // optional: your own WhatsApp number, lets you pause/resume the bot by texting it
  UPSTASH_REDIS_REST_URL, // optional: Upstash database URL, lets the bot remember chats for days
  UPSTASH_REDIS_REST_TOKEN, // optional: Upstash database token (goes with the URL above)
} = process.env;
const SHEET_GID = process.env.SHEET_GID || "0";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v23.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

// ---------- Fixed shop info (not in the Sheet) ----------
const SHOP_INFO = `SHOP INFORMATION:
Shop: Aiperi Wear — women's clothing, Instagram-based shop in Bishkek

DELIVERY
- Within Bishkek: 150 KGS, same-day if ordered before 3pm
- Other regions (Osh, Karakol, etc.): 300–500 KGS via delivery service, 2–4 days
- Free pickup near Ala-Too Square

HOURS
Monday–Saturday, 10:00–19:00. Closed Sundays.

RETURNS
Exchange only within 3 days if tags are still attached. No refunds.`;

function buildSystemPrompt(rows) {
  return `You are the WhatsApp assistant for a small clothing shop. Answer customer questions warmly and briefly, like a real quick chat reply, not a formal essay. Only use the shop information and product data below; if something isn't covered by them, say you'll check with the owner and get back to them rather than guessing. Never infer availability, price, or color from similar products. Never mention that you are an AI.

Reply in the same language the customer writes in, including the greeting (for Russian start with "Здравствуйте" or "Привет", never "Hi"). Translate every word of your reply into the customer's language, including colors, sizes, materials and descriptive words inside product names (e.g. "oversized" becomes "оверсайз" in Russian). When replying in Russian, use no Latin-alphabet words.

Product data is fresh from the shop's spreadsheet with every message. Always use it, never rely on earlier messages for prices or stock.

You may see earlier messages with this customer, sometimes from previous days. Use them to remember what the customer asked about, liked, or ordered, and their size, so they don't have to repeat themselves.

Each product object may have a "Photo" field and a "Video" field. These are independent of each other — an item can have a photo, a video, both, or neither, regardless of what the other field contains. Check each one separately; never assume one is empty just because the other is.

If the customer asks to see a specific item or color (a photo/picture), look up that exact item's "Photo" field in the product data above and copy its value into "image_url" character-for-character. If that field is empty, leave "image_url" empty and say you'll send a photo soon. Never guess or reuse another item's photo. Do not put links in "reply".

If the customer asks for a video of an item, look up that exact item's "Video" field in the product data above (do not look at "Photo" for this) and copy its value into "video_url" character-for-character. If that field is empty, leave "video_url" empty and say you'll send one soon. Never guess or reuse another item's video.

Answer ONLY with a JSON object: {"reply": "<text for the customer>", "image_url": "<photo URL or empty string>", "video_url": "<video URL or empty string>"}

PRODUCT DATA (JSON, one object per product):
${JSON.stringify(rows)}

QUICK REFERENCE — trust this list over your own reading of the JSON above if they ever seem to disagree:
- Items that currently HAVE a video available: ${rows.filter((r) => r.Video).map((r) => r.Item).join(", ") || "(none right now)"}
- Items that currently HAVE a photo available: ${rows.filter((r) => r.Photo).map((r) => r.Item).join(", ") || "(none right now)"}
Any item not named in a line above does NOT have that media yet — for those, still copy the exact URL from its field once it does.

${SHOP_INFO}`;
}

// ---------- Google Sheet (must be shared as "Anyone with the link: Viewer") ----------
let catalogCache = { rows: null, at: 0 };

async function fetchCatalog() {
  if (catalogCache.rows && Date.now() - catalogCache.at < 15000) {
    return catalogCache.rows;
  }
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok || text.trim().startsWith("<")) {
    throw new Error(
      "Could not read the Google Sheet. Check SHEET_ID and that sharing is 'Anyone with the link: Viewer'."
    );
  }
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
  catalogCache = { rows, at: Date.now() };
  return rows;
}

// ---------- Chat memory ----------
// Each customer's recent messages are saved in an Upstash Redis database so the bot
// remembers them across days and server restarts. Without Upstash settings it falls
// back to keeping them in the server's memory only (lost on every restart).
const MAX_HISTORY = 30; // messages kept per customer (about 15 back-and-forths)
const HISTORY_DAYS = 30; // a customer's memory is forgotten after this many days of silence
const NEW_VISIT_HOURS = 3; // a gap longer than this counts as "a new conversation"
const useRedis = Boolean(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);
const localHistory = new Map(); // fallback, and a backup if the database is briefly unreachable

async function redis(command) {
  const res = await fetch(UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
    body: JSON.stringify(command),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Upstash error ${res.status}: ${data.error || "no details"}`);
  return data.result;
}

async function loadHistory(from) {
  if (useRedis) {
    try {
      const raw = await redis(["GET", `chat:${from}`]);
      return raw ? JSON.parse(raw) : [];
    } catch (err) {
      console.error("Could not load chat memory, using local copy:", err.message);
    }
  }
  return localHistory.get(from) || [];
}

async function saveHistory(from, past) {
  const trimmed = past.slice(-MAX_HISTORY);
  localHistory.set(from, trimmed);
  if (useRedis) {
    try {
      await redis(["SET", `chat:${from}`, JSON.stringify(trimmed), "EX", String(HISTORY_DAYS * 86400)]);
    } catch (err) {
      console.error("Could not save chat memory:", err.message);
    }
  }
}

const bishkekTime = (ms) =>
  new Date(ms).toLocaleString("ru-RU", { timeZone: "Asia/Bishkek", dateStyle: "long", timeStyle: "short" });

// Handle one customer's messages one at a time, so quick back-to-back messages
// don't overwrite each other's memory and replies stay in order.
const queues = new Map();
function runInOrder(key, task) {
  const next = (queues.get(key) || Promise.resolve()).then(task, task);
  queues.set(key, next);
  const cleanup = () => {
    if (queues.get(key) === next) queues.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

// ---------- OpenAI ----------
async function askAI(from, userText) {
  const rows = await fetchCatalog();
  const past = await loadHistory(from);

  // If the customer is coming back after a break, tell the AI so it treats the
  // earlier messages as a previous conversation (e.g. "yesterday you asked about...").
  const last = past[past.length - 1];
  const now = Date.now();
  const visitNote =
    last && last.at && now - last.at > NEW_VISIT_HOURS * 3600 * 1000
      ? [
          {
            role: "system",
            content: `The messages above are from an earlier conversation with this customer (their last message was on ${bishkekTime(last.at)}; it is now ${bishkekTime(now)}, Bishkek time). The customer is writing again now.`,
          },
        ]
      : [];

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt(rows) },
        ...past.map(({ role, content }) => ({ role, content })),
        ...visitNote,
        { role: "user", content: userText },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();

  let parsed;
  try {
    parsed = JSON.parse(data.choices[0].message.content);
  } catch {
    throw new Error("OpenAI returned something that is not valid JSON");
  }
  const reply = String(parsed.reply || "").trim();

  // Only allow photo/video links that really exist in the sheet
  const allowedPhotos = new Set(rows.map((r) => r.Photo).filter(Boolean));
  const image = allowedPhotos.has(parsed.image_url) ? parsed.image_url : "";

  const allowedVideos = new Set(rows.map((r) => r.Video).filter(Boolean));
  const video = allowedVideos.has(parsed.video_url) ? parsed.video_url : "";

  if (parsed.video_url && !video) {
    console.log(`AI returned a video_url that isn't in the sheet, dropping it: ${JSON.stringify(parsed.video_url)}`);
  }

  past.push({ role: "user", content: userText, at: now }, { role: "assistant", content: reply, at: Date.now() });
  await saveHistory(from, past);

  return { reply, image, video };
}

// ---------- WhatsApp sending ----------
async function sendWhatsApp(payload) {
  const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  if (!res.ok) {
    throw new Error(`WhatsApp send error ${res.status}: ${await res.text()}`);
  }
}

const sendText = (to, body) => sendWhatsApp({ to, type: "text", text: { body } });
const sendImage = (to, link) => sendWhatsApp({ to, type: "image", image: { link } });
const sendVideo = (to, link) => sendWhatsApp({ to, type: "video", video: { link } });

// ---------- Bot Status toggle ----------
// The owner can pause/resume the AI by texting the shop number from their own phone
// (set OWNER_PHONE to that number). While paused, customers get no auto-reply at all,
// so the owner can take over the chat manually from WhatsApp.
let botEnabled = true;
const OWNER_ID = String(OWNER_PHONE || "").replace(/\D/g, "");
const isOwner = (from) => Boolean(OWNER_ID) && String(from).replace(/\D/g, "") === OWNER_ID;

const OFF_CMD = /^(bot\s*off|pause\s*bot|бот\s*(выкл|стоп)|стоп\s*бот)$/i;
const ON_CMD = /^(bot\s*on|resume\s*bot|бот\s*(вкл|включи))$/i;
const STATUS_CMD = /^(bot\s*status|статус\s*бота)$/i;

// ---------- Handling one incoming message ----------
const seen = new Set(); // Meta sometimes delivers the same message twice

async function handleMessage(msg) {
  if (seen.has(msg.id)) return;
  seen.add(msg.id);
  if (seen.size > 2000) seen.delete(seen.values().next().value);

  const from = msg.from;

  // Owner-only commands to pause/resume the bot, checked before anything else
  if (msg.type === "text" && isOwner(from)) {
    const t = msg.text.body.trim();
    if (OFF_CMD.test(t)) {
      botEnabled = false;
      await sendText(from, "🔴 Бот приостановлен. Напишите «бот вкл», чтобы снова включить.");
      return;
    }
    if (ON_CMD.test(t)) {
      botEnabled = true;
      await sendText(from, "🟢 Бот снова отвечает клиентам.");
      return;
    }
    if (STATUS_CMD.test(t)) {
      await sendText(from, botEnabled ? "🟢 Бот включён." : "🔴 Бот выключен.");
      return;
    }
  }

  if (!botEnabled) {
    console.log(`Bot is paused, ignoring message from ${from}`);
    return;
  }

  if (msg.type !== "text") {
    await sendText(
      from,
      "Пожалуйста, напишите вопрос текстом — я пока не понимаю голосовые сообщения и файлы."
    );
    return;
  }

  try {
    const { reply, image, video } = await askAI(from, msg.text.body);
    if (reply) await sendText(from, reply);
    if (image) await sendImage(from, image);
    if (video) await sendVideo(from, video);
  } catch (err) {
    console.error("Failed to answer:", err.message);
    await sendText(from, "Секунду, уточню у владельца и вернусь к вам.").catch(() => {});
  }
}

// ---------- Web server ----------
const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf; // needed to check Meta's signature
    },
  })
);

app.get("/", (_req, res) => res.send("Aiperi Wear assistant is running"));

// Meta calls this once when you click "Verify and save"
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Meta calls this for every incoming customer message
app.post("/webhook", (req, res) => {
  if (APP_SECRET) {
    const sent = String(req.get("x-hub-signature-256") || "");
    const expected =
      "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody || "").digest("hex");
    const ok =
      sent.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
    if (!ok) return res.sendStatus(403);
  }

  res.sendStatus(200); // answer Meta right away, then work

  const changes = (req.body.entry || []).flatMap((e) => e.changes || []);
  for (const change of changes) {
    for (const msg of change.value?.messages || []) {
      runInOrder(msg.from, () => handleMessage(msg)).catch((err) =>
        console.error("Handler crashed:", err.message)
      );
    }
  }
});

if (require.main === module) {
  const missing = ["VERIFY_TOKEN", "WHATSAPP_TOKEN", "PHONE_NUMBER_ID", "OPENAI_API_KEY", "SHEET_ID"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) console.warn("Missing environment variables:", missing.join(", "));
  if (!OWNER_PHONE) console.warn("OWNER_PHONE not set — the Bot Status toggle (\"bot off\"/\"bot on\") is disabled.");
  console.log(
    useRedis
      ? "Chat memory: saved in Upstash (remembered across days and restarts)."
      : "Chat memory: UPSTASH_REDIS_REST_URL/TOKEN not set — chats are forgotten on every restart."
  );
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Listening on port ${port}`));
}

module.exports = { app, handleMessage, buildSystemPrompt };
