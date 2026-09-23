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

If the customer asks to see a specific item or color, set "image_url" to that exact item's Photo URL from the product data. If that item has no Photo URL, leave "image_url" empty and say you'll send a photo soon. Never guess or reuse another item's photo. Do not put links in "reply".

If the customer asks for a video of an item, set "video_url" to that exact item's Video URL from the product data. If that item has no Video URL, leave "video_url" empty and say you'll send one soon. Never guess or reuse another item's video.

Answer ONLY with a JSON object: {"reply": "<text for the customer>", "image_url": "<photo URL or empty string>", "video_url": "<video URL or empty string>"}

PRODUCT DATA (JSON, one object per product):
${JSON.stringify(rows)}

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

// ---------- OpenAI ----------
const history = new Map(); // phone number -> last messages (resets if the server restarts)
const MAX_HISTORY = 10;

async function askAI(from, userText) {
  const rows = await fetchCatalog();
  const past = history.get(from) || [];

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
        ...past,
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

  past.push({ role: "user", content: userText }, { role: "assistant", content: reply });
  history.set(from, past.slice(-MAX_HISTORY));

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
      await sendText(from, '🔴 Bot paused — I won\'t reply to customers until you text "bot on". / Бот приостановлен, напишите "bot on", чтобы включить.');
      return;
    }
    if (ON_CMD.test(t)) {
      botEnabled = true;
      await sendText(from, "🟢 Bot resumed. / Бот снова отвечает клиентам.");
      return;
    }
    if (STATUS_CMD.test(t)) {
      await sendText(from, botEnabled ? "🟢 Bot is ON." : "🔴 Bot is OFF.");
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
      "Пожалуйста, напишите вопрос текстом. / Please type your question, I can't read voice messages or files yet."
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
    await sendText(from, "Секунду, уточню у владельца и вернусь к вам. / One moment, I'll check with the owner.").catch(
      () => {}
    );
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
      handleMessage(msg).catch((err) => console.error("Handler crashed:", err.message));
    }
  }
});

if (require.main === module) {
  const missing = ["VERIFY_TOKEN", "WHATSAPP_TOKEN", "PHONE_NUMBER_ID", "OPENAI_API_KEY", "SHEET_ID"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) console.warn("Missing environment variables:", missing.join(", "));
  if (!OWNER_PHONE) console.warn("OWNER_PHONE not set — the Bot Status toggle (\"bot off\"/\"bot on\") is disabled.");
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Listening on port ${port}`));
}

module.exports = { app, handleMessage, buildSystemPrompt };
