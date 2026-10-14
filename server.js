// Aiperi Wear WhatsApp assistant
// Flow: WhatsApp message -> read live Google Sheet -> ask OpenAI -> reply on WhatsApp

const express = require("express");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
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
  ALERT_PHONE, // optional: number(s) that get "a customer needs you" alerts, comma-separated; defaults to OWNER_PHONE
  UPSTASH_REDIS_REST_URL, // optional: Upstash database URL, lets the bot remember chats for days
  UPSTASH_REDIS_REST_TOKEN, // optional: Upstash database token (goes with the URL above)
  APPS_SCRIPT_URL, // optional: Google Apps Script Web App URL, lets the owner update the catalog by texting the bot
  UPDATE_SECRET, // optional: must match the SECRET set inside that Apps Script
  ORDER_ALERT_PHONE, // optional: number(s) that get "new order" alerts, comma-separated; defaults to ALERT_PHONE/OWNER_PHONE
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
  return `You work the WhatsApp chat of a small clothing shop, the way a friendly, quick-witted shop assistant would: you text, you do not write letters. Only use the shop information and product data below; if something isn't covered by them, say you'll check with the owner and get back to them rather than guessing. Never infer availability, price, or color from similar products.

HUMAN STYLE (this matters as much as the facts; the reply must read like a real person typing on a phone):
- Keep it short: usually 1 or 2 short sentences, 3 at the very most. Match the customer's length and energy: a one-word question gets a short answer.
- Write the way people actually text: simple everyday words, a relaxed tone, contractions in English. No stiff or corporate phrases ("We are pleased to inform you", "Благодарим за обращение", "Рады сообщить", "Уважаемый клиент", "Обращайтесь, если возникнут вопросы"), and no customer-service filler such as "Конечно! Я с радостью вам помогу" or "Great question!".
- Answer the actual question first, straight away. Add at most one useful extra detail (for example the other sizes, or that there is a photo). Never repeat the customer's question back to them.
- Never use bullet points, numbered lists, bold text, headings or markdown in a reply. If several items fit, mention two or three in a sentence and ask which style they like instead of listing the whole catalog.
- Greet only in the FIRST message of a chat, or when the customer says hello again after a long break. In later messages just answer, with no new greeting and no "Здравствуйте" at the start.
- Don't end every message with a question or an offer of more help. Ask a follow-up only when it moves things forward (their size, which colour, whether they want to order), and ask only one thing at a time. Don't close with "Обращайтесь!" or "Let me know if you need anything else".
- Vary how you start and finish replies; never use the same opening twice in a row. Small natural reactions are good when they fit ("о, отличный выбор", "ооо, этот сейчас очень берут", "ok, отлично", "аа, понятно"), but don't overdo it.
- At most one emoji in a message, and many messages have none. Skip emojis completely when the customer is upset or the topic is serious.
- Write prices as people say them ("5 500 сом"), and keep names of items short and natural, as a customer would say them, not as a spreadsheet row.
- Speak as part of the shop team ("у нас", "мы", "we've got"). Do not invent a personal name, age, family, or life story for yourself. Never say things like "as an AI", "as a virtual assistant", "I am a bot", "my database", "according to the data", "the system" or "I'm programmed". If the customer asks something you can't see in the data, say it the way a shop assistant would: "сейчас уточню", never "у меня нет информации".
- If a customer sincerely and directly asks whether they are talking to a real person or a bot, don't claim to be a human. Answer briefly and honestly that you are the shop's virtual assistant, and keep helping (the owner is always there for anything special). Never bring this up yourself.
- Sound the same in every language: in Kyrgyz and Russian write the colloquial everyday way (not textbook or translated-sounding), in English plain casual shop English.

LANGUAGE: Customers write in Russian, Kyrgyz or English. Always reply in the language of the customer's LATEST message, and switch if they switch. A system line near the end of the conversation, "LANGUAGE FOR THIS REPLY", names that language: follow it exactly.
- If the customer writes in English, reply entirely in English, with no Russian or Kyrgyz words. Greet with "Hello" or "Hi". Translate the catalog's item names, colors and descriptions into natural English (for example "Зыгыр жейде — ак" becomes "white linen shirt"). The only exception is "order_item", which must still be copied exactly from the catalog.
- Kyrgyz is a different language from Russian, even though both use Cyrillic. Kyrgyz messages often contain the letters ң, ө, ү or words like салам, саламатсызбы, канча, барбы, бар, жок, рахмат, кандай, эмне, керек, көрсөтүңүз. If the customer writes in Kyrgyz, reply entirely in Kyrgyz and never answer a Kyrgyz message in Russian. Greet with "Саламатсызбы" (or "Салам" if they were casual). In Kyrgyz replies, product names may stay exactly as written in the catalog.
- If the customer writes in Russian, reply in Russian. Greet with "Здравствуйте" (or "Привет" if they were casual), never "Hi". The catalog is written in Kyrgyz, so translate item names, colors, materials and descriptive words into natural Russian (e.g. "oversized" becomes "оверсайз").
- In Russian and Kyrgyz replies use no Latin-alphabet words, except clothing size labels such as S, M, L, XL, which stay as they are.
- Put the language you replied in into "language": "ky" for Kyrgyz, "ru" for Russian, "en" for English.

Product data is fresh from the shop's spreadsheet with every message. Always use it, never rely on earlier messages for prices or stock.

STOCK: whether an item is available comes ONLY from its "Саны" field, the number of pieces in stock. If "Саны" is 0, the item is sold out right now, so say it's not available at the moment. If it is 1 or more, the item is in stock. If "Саны" is empty, you don't know the stock, so say you'll check with the owner. Don't volunteer exact numbers, just say it's available; if the customer asks how many are left, tell them the number from "Саны".

You may see earlier messages with this customer, sometimes from previous days. Use them to remember what the customer asked about, liked, or ordered, and their size, so they don't have to repeat themselves.

Each product object may have a "Photo" field and a "Video" field. These are independent of each other — an item can have a photo, a video, both, or neither, regardless of what the other field contains. Check each one separately; never assume one is empty just because the other is.

Only attach a photo or video when the customer's LATEST message asks to see one (e.g. "покажите", "фото", "как выглядит", "сүрөт", "көрсөтүңүз", "show me"). For follow-up questions about price, sizes, stock, colors or delivery, leave "image_url" and "video_url" empty. Your earlier replies in this chat show which photos/videos you already sent; never send the same one again unless the customer asks for it again.

If the customer asks to see a specific item or color (a photo/picture), look up that exact item's "Photo" field in the product data above and copy its value into "image_url" character-for-character. If that field is empty, leave "image_url" empty and say you'll send a photo soon. Never guess or reuse another item's photo. Do not put links in "reply".

If the customer asks for a video of an item, look up that exact item's "Video" field in the product data above (do not look at "Photo" for this) and copy its value into "video_url" character-for-character. If that field is empty, leave "video_url" empty and say you'll send one soon. Never guess or reuse another item's video.

When you need to check with the owner (see below), don't use a fixed template sentence. Phrase it the way a real person quickly texting a customer would — casual, brief, varied each time. For example, instead of always writing "Я уточню у владельца насчет скидки и сообщу вам", mix it up naturally: "Хороший вопрос, спрошу у хозяина и напишу вам", "Дайте уточню у владельца, скоро отвечу", "Сейчас узнаю у хозяина насчёт этого", etc. — same idea, different words each time, like a real shop assistant would text. Always still make clear you're checking with the shop owner and will follow up, just never repeat the exact same sentence twice in one conversation.

Set "needs_owner" to true whenever your reply says you'll check with the owner, promises to send a photo/video later, or otherwise leaves the customer waiting for a human (questions you can't answer from the shop information and product data, complaints, special requests, or anything off-topic). Otherwise set it to false.

CRITICAL, CHECK THIS LAST BEFORE YOU ANSWER: read back your own "reply" text. Does it contain anything like "уточню у владельца", "скоро вернусь с ответом", "спрошу у владельца", "tактап", "I'll check with the owner", "I'll get back to you", "I'll ask the owner", or any other promise that a human will follow up? If yes, "needs_owner" MUST be true — no exceptions, even if you answered a similar question this way earlier in the conversation. Only set "needs_owner" to false when your reply fully answers the question itself, with no promise of a follow-up from anyone.

ORDERS: Set "order" to true only when the customer clearly confirms they want to BUY a specific item right now — phrases like "беру", "заказываю", "хочу купить это", "алам", "беру этот", "I'll take it", "I want to order this". More phrases that count as a purchase confirmation: "хочу купить", "хочу заказать", "хочу его", "оформляйте", "давайте оформим", "сатып алам", "алгым келет", "алам", "I want to buy it", "I'll buy it", "I want it", "let's do it". If the customer says one of these about the item you were just discussing, it IS an order. CONSISTENCY CHECK: if your "reply" confirms or thanks the customer for an order (for example "вы заказали...", "ваш заказ принят", "you've ordered..."), then "order" MUST be true and "order_item" and "order_price" MUST be filled in. Never write an order confirmation while leaving "order" false. A question about price, size or availability is NOT an order, even if they seem interested — only a clear purchase confirmation counts. When "order" is true, you must be able to tell exactly which single item they mean from the conversation (the item they were just discussing); if it's unclear which item, set "order" to false and ask them to confirm which item instead. When "order" is true, also fill "order_item" (the exact item name, copied character-for-character from the product data's item name field) and "order_price" (the numeric price for that item, as a plain number with no currency symbol). Your "reply" should warmly confirm the order back to the customer. When "order" is false, leave "order_item" and "order_price" as empty strings.

MOOD: judge the customer's LATEST message and put "calm", "upset" or "angry" in "mood". "angry" means clearly angry, rude, insulting, threatening, or demanding a refund or the manager in a harsh way. "upset" means disappointed or complaining about something that went wrong (late or wrong order, bad quality, poor service). Everything else, including normal questions about returns or delivery, is "calm". When "mood" is "upset" or "angry": apologize sincerely in one short sentence, do not argue or make excuses, do not promise a refund, discount or any compensation, and say the owner will personally get in touch very soon. Set "needs_owner" to true.

Answer ONLY with a JSON object: {"reply": "<text for the customer>", "image_url": "<photo URL or empty string>", "video_url": "<video URL or empty string>", "language": "<ky, ru or en>", "needs_owner": <true or false>, "order": <true or false>, "order_item": "<exact item name or empty string>", "order_price": <number or empty string>, "mood": "<calm, upset or angry>"}

PRODUCT DATA (JSON, one object per product):
${JSON.stringify(rows)}

QUICK REFERENCE — trust this list over your own reading of the JSON above if they ever seem to disagree:
- Items that currently HAVE a video available: ${rows.filter((r) => r.Video).map((r) => r["Одежды"]).join(", ") || "(none right now)"}
- Items that currently HAVE a photo available: ${rows.filter((r) => r.Photo).map((r) => r["Одежды"]).join(", ") || "(none right now)"}
Any item not named in a line above does NOT have that media yet — for those, still copy the exact URL from its field once it does.

${shopInfoText(currentShop())}`;
}

// The "SHOP INFORMATION" block of the prompt for one shop.
function shopInfoText(shop) {
  const info = String(shop.info || "").trim();
  if (info.toUpperCase().startsWith("SHOP INFORMATION")) return info;
  return `SHOP INFORMATION:\nShop: ${shop.name}\n\n${info || "No delivery, hours or returns information has been provided. For questions about those, say you'll check with the owner."}`;
}

// ---------- Shops (one bot, many shops) ----------
// Shops are listed in the "Shops" tab of the master Google Sheet (the SHEET_ID
// spreadsheet). Columns: code | name | catalog_gid | orders_gid | owner_phone |
// alert_phone | info.  catalog_gid / orders_gid are the numbers after "gid=" in the
// address bar when that tab is open.
// A customer picks a shop by writing its code in a message (for example from a
// wa.me link ending in ?text=nur). We remember the choice for that customer.
// If the Shops tab can't be read, the bot falls back to the single shop described by
// the environment variables, so nothing breaks.
const SHOPS_GID = process.env.SHOPS_GID || "577858349";
const DEFAULT_SHOP_CODE = String(process.env.DEFAULT_SHOP || "").trim().toLowerCase();
const shopStore = new AsyncLocalStorage(); // "which shop is this message about" follows the code around

const digitsList = (s) =>
  String(s || "")
    .split(",")
    .map((n) => n.replace(/\D/g, ""))
    .filter(Boolean);

// The single shop described by environment variables (the original setup, and the fallback).
function envShop() {
  const alertTo = digitsList(ALERT_PHONE || OWNER_PHONE);
  return {
    code: "default",
    name: "Aiperi Wear",
    catalogGid: SHEET_GID,
    ordersGid: "",
    ownerIds: digitsList(OWNER_PHONE),
    alertTo,
    orderAlertTo: ORDER_ALERT_PHONE ? digitsList(ORDER_ALERT_PHONE) : alertTo,
    info: SHOP_INFO,
    isDefault: true,
  };
}

// The Shops tab's column names can be English or Kyrgyz:
// code/код, name/аталышы, catalog_gid/каталог_gid, orders_gid/заказдар_gid,
// owner_phone/ээсинин_телефону, alert_phone/эскертме_телефону, info/маалымат.
function rowToShop(row) {
  const get = (...names) => {
    const found = names.find((n) => row[n] !== undefined);
    return found === undefined ? "" : row[found];
  };
  const code = String(get("code", "код")).trim().toLowerCase();
  if (!code) return null;
  const ownerIds = digitsList(get("owner_phone", "ээсинин_телефону"));
  const alerts = digitsList(get("alert_phone", "эскертме_телефону"));
  const alertTo = alerts.length ? alerts : ownerIds;
  return {
    code,
    name: String(get("name", "аталышы") || code).trim(),
    catalogGid: String(get("catalog_gid", "каталог_gid")).trim() || "0",
    ordersGid: String(get("orders_gid", "заказдар_gid")).trim(),
    ownerIds,
    alertTo,
    orderAlertTo: alertTo,
    info: String(get("info", "маалымат")).trim(),
    isDefault: false,
  };
}

let shopsCache = { list: null, at: 0 };

async function getShops() {
  if (shopsCache.list && Date.now() - shopsCache.at < 60000) return shopsCache.list;
  let list = null;
  try {
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHOPS_GID}`);
    const text = await res.text();
    if (!res.ok || text.trim().startsWith("<")) throw new Error(`HTTP ${res.status}`);
    const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
    list = rows.map(rowToShop).filter(Boolean);
  } catch (err) {
    console.error("Could not read the Shops tab:", err.message);
    if (shopsCache.list) {
      shopsCache.at = Date.now(); // keep using the last good copy for another minute
      return shopsCache.list;
    }
  }
  if (!list || !list.length) list = [envShop()];
  // The default shop: the one named in DEFAULT_SHOP, otherwise the first row.
  const def = list.find((s) => s.code === DEFAULT_SHOP_CODE) || list[0];
  for (const s of list) s.isDefault = s === def;
  // The original OWNER_PHONE setting keeps working as an owner of the default shop.
  def.ownerIds = [...new Set([...def.ownerIds, ...digitsList(OWNER_PHONE)])];
  shopsCache = { list, at: Date.now() };
  return list;
}

const currentShop = () => shopStore.getStore() || envShop();
const runAsShop = (shop, fn) => shopStore.run(shop, fn);

// Which shop a customer is talking to: a shop code in their message switches it,
// otherwise the shop they chose before, otherwise the default shop.
const localCustomerShop = new Map(); // fallback when Redis is off or unreachable

async function savedShopCode(from) {
  if (useRedis) {
    try {
      const code = await redis(["GET", `shop:${from}`]);
      if (code) return String(code);
    } catch (err) {
      console.error("Could not load the customer's shop, using local copy:", err.message);
    }
  }
  return localCustomerShop.get(from) || "";
}

async function saveShopCode(from, code) {
  localCustomerShop.set(from, code);
  if (useRedis) {
    try {
      await redis(["SET", `shop:${from}`, code, "EX", String(HISTORY_DAYS * 86400)]);
    } catch (err) {
      console.error("Could not save the customer's shop:", err.message);
    }
  }
}

// A shop whose code appears in the text as a whole word (case-insensitive).
function shopCodeInText(shops, text) {
  const t = ` ${String(text || "").toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, " ")} `;
  return shops.find((s) => t.includes(` ${s.code} `)) || null;
}

async function resolveShopForCustomer(from, text) {
  const shops = await getShops();
  const byCode = shopCodeInText(shops, text);
  if (byCode) {
    await saveShopCode(from, byCode.code);
    return byCode;
  }
  const saved = await savedShopCode(from);
  return shops.find((s) => s.code === saved) || shops.find((s) => s.isDefault) || shops[0];
}

// ---------- Google Sheet (must be shared as "Anyone with the link: Viewer") ----------
const catalogCaches = new Map(); // catalog tab (gid) -> { rows, at }

async function fetchCatalog() {
  const gid = currentShop().catalogGid;
  const cached = catalogCaches.get(gid);
  if (cached && cached.rows && Date.now() - cached.at < 15000) {
    return cached.rows;
  }
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok || text.trim().startsWith("<")) {
    throw new Error(
      "Could not read the Google Sheet. Check SHEET_ID and that sharing is 'Anyone with the link: Viewer'."
    );
  }
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true }).map(normalizeRow);
  catalogCaches.set(gid, { rows, at: Date.now() });
  return rows;
}

// The sheet's column names can be in Kyrgyz (Кийим, Сүрөт, Видео) or the older names
// (Одежды, Photo, Video). The rest of the code always sees "Одежды", "Photo" and "Video".
const COLUMN_NAMES = {
  "Одежды": ["Одежды", "Кийим"],
  Photo: ["Photo", "Сүрөт"],
  Video: ["Video", "Видео"],
};
function normalizeRow(r) {
  const out = { ...r };
  for (const [usual, names] of Object.entries(COLUMN_NAMES)) {
    const found = names.find((n) => out[n] !== undefined);
    const value = found !== undefined ? out[found] : "";
    for (const n of names) delete out[n];
    out[usual] = value;
  }
  return out;
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

// A customer has a separate chat memory with each shop. The default shop keeps the
// original key ("chat:<phone>") so existing memories carry over.
const historyKey = (from) => {
  const shop = currentShop();
  return shop.isDefault ? `chat:${from}` : `chat:${shop.code}:${from}`;
};

async function loadHistory(from) {
  const key = historyKey(from);
  if (useRedis) {
    try {
      const raw = await redis(["GET", key]);
      return raw ? JSON.parse(raw) : [];
    } catch (err) {
      console.error("Could not load chat memory, using local copy:", err.message);
    }
  }
  return localHistory.get(key) || [];
}

async function saveHistory(from, past) {
  const key = historyKey(from);
  const trimmed = past.slice(-MAX_HISTORY);
  localHistory.set(key, trimmed);
  if (useRedis) {
    try {
      await redis(["SET", key, JSON.stringify(trimmed), "EX", String(HISTORY_DAYS * 86400)]);
    } catch (err) {
      console.error("Could not save chat memory:", err.message);
    }
  }
}

const bishkekTime = (ms) =>
  new Date(ms).toLocaleString("ru-RU", { timeZone: "Asia/Bishkek", dateStyle: "long", timeStyle: "short" });

// ---------- Analytics ----------
// Simple daily counters kept in Upstash Redis (one hash per day: stats:YYYY-MM-DD).
// The owner texts "статистика" to get today + the last 7 days. Without Upstash the
// counters live in server memory only (lost on restart). Recording a stat never
// throws, so analytics can never break a customer's reply.
const MINUTES_PER_REPLY = Number(process.env.MINUTES_PER_REPLY) || 2; // rough time a human spends on one reply
const STATS_DAYS = 60; // daily counters are deleted after this many days
const STAT_FIELDS = ["messages", "answered", "escalated", "orders", "complaints", "errors"];
const localStats = new Map(); // day -> { field: count }, fallback when Redis is off or unreachable

const bishkekDay = (ms = Date.now()) =>
  new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Bishkek" }); // "2026-10-14"

// Each shop has its own counters. The default shop keeps the original key ("stats:<day>").
const statsKey = (day) => {
  const shop = currentShop();
  return shop.isDefault ? `stats:${day}` : `stats:${shop.code}:${day}`;
};

async function bump(field) {
  try {
    const key = statsKey(bishkekDay());
    const local = localStats.get(key) || {};
    local[field] = (local[field] || 0) + 1;
    localStats.set(key, local);
    if (useRedis) {
      await redis(["HINCRBY", key, field, "1"]);
      await redis(["EXPIRE", key, String(STATS_DAYS * 86400)]);
    }
  } catch (err) {
    console.error("Could not record stat:", err.message);
  }
}

async function loadDay(day) {
  const key = statsKey(day);
  if (useRedis) {
    try {
      const raw = await redis(["HGETALL", key]);
      const out = {};
      if (Array.isArray(raw)) {
        for (let i = 0; i + 1 < raw.length; i += 2) out[raw[i]] = Number(raw[i + 1]) || 0;
      } else if (raw && typeof raw === "object") {
        for (const k of Object.keys(raw)) out[k] = Number(raw[k]) || 0;
      }
      return out;
    } catch (err) {
      console.error("Could not load stats, using local copy:", err.message);
    }
  }
  return localStats.get(key) || {};
}

const sumStats = (list) =>
  list.reduce((total, d) => {
    for (const k of STAT_FIELDS) total[k] = (total[k] || 0) + (d[k] || 0);
    return total;
  }, {});

function fmtMinutes(min) {
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

function statsBlock(s) {
  const messages = s.messages || 0;
  const answered = s.answered || 0;
  const pct = messages ? Math.round((answered / messages) * 100) : 0;
  return [
    `💬 Сообщений от клиентов: ${messages}`,
    `✅ Бот ответил сам: ${answered} (${pct}%)`,
    `🙋 Передано вам: ${s.escalated || 0}`,
    `🛒 Заказов: ${s.orders || 0}`,
    `😟 Недовольных клиентов: ${s.complaints || 0}`,
    `⚠️ Ошибок: ${s.errors || 0}`,
    `⏱ Сэкономлено времени: ~${fmtMinutes(answered * MINUTES_PER_REPLY)}`,
  ].join("\n");
}

async function buildStatsReport() {
  const days = Array.from({ length: 7 }, (_, i) => bishkekDay(Date.now() - i * 86400000));
  const data = await Promise.all(days.map(loadDay));
  return (
    `📊 Статистика\n\n` +
    `Сегодня\n${statsBlock(data[0])}\n\n` +
    `За 7 дней\n${statsBlock(sumStats(data))}\n\n` +
    `Время — примерная оценка: ${MINUTES_PER_REPLY} мин на один ответ.`
  );
}

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

// ---------- Customer language (for the few fixed messages the AI doesn't write) ----------
const LANGS = ["ky", "ru", "en"];
const FIXED = {
  notText: {
    ru: "Ой, голосовое сейчас не получится послушать. Напишите текстом, пожалуйста 🙏",
    ky: "Үн билдирүүнү азыр уга албайм. Тексттик билдирүү жазып жибересизби 🙏",
  },
  checking: {
    ru: "Секунду, сейчас уточню и вернусь к вам.",
    ky: "Бир мүнөт, азыр тактап, сизге кайра жазам.",
  },
};
const KYRGYZ_LETTERS = /[ңөүҢӨҮ]/;
// Common Kyrgyz words (for messages without ң, ө or ү). \b doesn't work with Cyrillic, so we use lookarounds.
const KYRGYZ_WORDS =
  /(?<![\p{L}])(салам|саламатсызбы|саламатсыздарбы|канча|барбы|жокпу|рахмат|кандай|эмне|керек|көрсөт\p{L}*|сүрөт\p{L}*|кечиресиз|болобу|баасы|өлчөм\p{L}*|алам|алгым|берсеңиз|жардам|бүгүн|кийим|буйрутма)(?![\p{L}])/iu;
const SIZE_LABEL = /^(xs|s|m|l|xl|xxl|xxxl)$/;
const LANG_NAME = { ru: "Russian", ky: "Kyrgyz", en: "English" };

// "ru", "ky" or "en" for the language of a customer's message, or null when it's too
// short or unclear to tell (a lone shop code, "ok", a number, just a size like "XL").
function detectLanguage(text, shopCodes = []) {
  const tokens = String(text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w && !shopCodes.includes(w));
  const t = tokens.join(" ");
  const cyr = (t.match(/[Ѐ-ӿ]/g) || []).length;
  const lat = (t.match(/[a-z]/g) || []).length;
  if (cyr + lat < 2) return null;
  if (lat > cyr) {
    const englishWords = tokens.filter((w) => /^[a-z]{3,}$/.test(w) && !SIZE_LABEL.test(w));
    return englishWords.length ? "en" : null;
  }
  return KYRGYZ_LETTERS.test(t) || KYRGYZ_WORDS.test(t) ? "ky" : "ru";
}

// Does a reply look like it is written in the wanted language? (by alphabet only)
function replyMatchesLanguage(reply, target) {
  const cyr = (reply.match(/[Ѐ-ӿ]/g) || []).length;
  const lat = (reply.match(/[a-z]/gi) || []).length;
  // Russian/Kyrgyz replies may contain a few Latin words (a shop name, a size like XL), so be tolerant
  return target === "en" ? cyr <= lat : cyr * 2 >= lat;
}

// Kyrgyz if this message has Kyrgyz-only letters, otherwise the language the AI
// last replied to this customer in, otherwise Russian.
async function customerLanguage(from, text = "") {
  if (KYRGYZ_LETTERS.test(text)) return "ky";
  const past = await loadHistory(from);
  const lastLang = [...past].reverse().find((m) => m.lang)?.lang;
  return lastLang === "ky" ? "ky" : "ru";
}

// Words customers use when they want to see a photo/video (Russian, Kyrgyz, English)
const ASKS_FOR_MEDIA = /фот|покаж|скин|картин|посмотр|выгляд|видео|сүрөт|көрсөт|photo|pic|show|\bsee\b|video/i;

// Past replies are shown to the AI in the same JSON shape it answers in,
// so it can see which photos/videos it already sent.
function toOpenAIMessage(m) {
  if (m.role !== "assistant") return { role: m.role, content: m.content };
  return {
    role: "assistant",
    content: JSON.stringify({ reply: m.content, image_url: m.image || "", video_url: m.video || "" }),
  };
}

// The bot's replies defer to the owner in many different phrasings (we want
// natural, varied wording, not a fixed template). Rather than match exact
// sentences, we check for an "owner" word (влад.../хозя.../ээ.../owner)
// together with a "checking / getting back to you" word nearby in the same
// reply. This is what actually triggers the alert — not the AI's own
// "needs_owner" flag, which isn't reliable enough on its own.
const OWNER_WORD = /влад[её]л|хозя|ээси|ээден|ээге|\bowner\b/i;
const CHECKING_WORD = /уточн|узна|спрош|поинтерес|свяж|тактап|сообщ|дам знать|вернусь|напишу|напиш|отвеч|check|ask|find out|get back|let you know|confirm/i;
const DEFERS_TO_OWNER = (text) => OWNER_WORD.test(text) && CHECKING_WORD.test(text);

// Strongly negative words in a CUSTOMER message (Russian, Kyrgyz, English). A backstop
// for the AI's "mood" judgement, which isn't fully reliable on its own. Deliberately
// leaves out neutral words like "возврат", so asking about returns is not a complaint.
const COMPLAINT_WORD =
  /ужас|кошмар|безобраз|обман|мошенни|развод|хамств|хамит|наглост|отвратительн|отстой|недовол|возмутительн|жалоб|надоел|сколько можно|scam|terrible|awful|worst|rude|disgust|unacceptable|complain|ridiculous|алдап|алдад|нааразы|шармандалык|уят эмеспи/i;

// Wording a reply uses when it confirms an order to the customer (Russian, Kyrgyz, English).
const ORDER_CONFIRMED =
  /заказали|заказ\s+(принят|оформлен|подтвержд)|оформил[аи]?\s+заказ|you['’]?ve ordered|you ordered|order (has been |is )?(placed|confirmed|received)|буйрутма(ңыз)?\s+(кабыл|тапшыр|бер)|заказ\s+бердиңиз/i;

// Compare item names ignoring case, extra spaces and which kind of dash is used.
const normName = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[—–−-]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();

// Looks through texts (newest first) for a catalog item name and returns the row of
// the first text that has one (the longest name wins if several appear in it).
function lastMentionedItem(rows, texts) {
  for (const text of texts) {
    const t = normName(text);
    if (!t) continue;
    const hits = rows
      .filter((r) => normName(r["Одежды"]) && t.includes(normName(r["Одежды"])))
      .sort((a, b) => normName(b["Одежды"]).length - normName(a["Одежды"]).length);
    if (hits.length) return hits[0];
  }
  return null;
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

  // Which language to reply in, decided here (not left to the AI): the language of the
  // customer's latest message; if that is unclear (e.g. just a shop code), the language
  // we last used with them; for a brand-new chat, Russian.
  const shopCodes = (await getShops()).map((s) => s.code);
  const lastLang = [...past].reverse().find((m) => m.lang)?.lang;
  const target = detectLanguage(userText, shopCodes) || lastLang || (past.length === 0 ? "ru" : null);
  const langNote = target
    ? [
        {
          role: "system",
          content: `LANGUAGE FOR THIS REPLY: the customer's latest message is in ${LANG_NAME[target]}. Write the whole "reply" in ${LANG_NAME[target]} and set "language" to "${target}".`,
        },
      ]
    : [];

  const callModel = async (extra = []) => {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.6, // a little variety so replies don't sound canned
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt(rows) },
          ...past.map(toOpenAIMessage),
          ...visitNote,
          ...langNote,
          ...extra,
          { role: "user", content: userText },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    try {
      return JSON.parse(data.choices[0].message.content);
    } catch {
      throw new Error("OpenAI returned something that is not valid JSON");
    }
  };

  let parsed = await callModel();
  // If the reply came out in the wrong alphabet/language, ask once more, firmly.
  if (target && !replyMatchesLanguage(String(parsed.reply || ""), target)) {
    console.log(`Reply was not in ${target}, asking again`);
    parsed = await callModel([
      { role: "system", content: `Your previous answer was not in ${LANG_NAME[target]}. Answer again, entirely in ${LANG_NAME[target]}.` },
    ]);
  }
  const reply = String(parsed.reply || "").trim();

  // Only allow photo/video links that really exist in the sheet
  const allowedPhotos = new Set(rows.map((r) => r.Photo).filter(Boolean));
  let image = allowedPhotos.has(parsed.image_url) ? parsed.image_url : "";

  const allowedVideos = new Set(rows.map((r) => r.Video).filter(Boolean));
  let video = allowedVideos.has(parsed.video_url) ? parsed.video_url : "";

  if (parsed.video_url && !video) {
    console.log(`AI returned a video_url that isn't in the sheet, dropping it: ${JSON.stringify(parsed.video_url)}`);
  }

  // Don't send the same photo/video again on every follow-up question,
  // only when the customer actually asks to see it again.
  if (!ASKS_FOR_MEDIA.test(userText)) {
    if (image && past.some((m) => m.image === image)) image = "";
    if (video && past.some((m) => m.video === video)) video = "";
  }

  const lang = target || (LANGS.includes(parsed.language) ? parsed.language : undefined);

  // How the customer feels: the AI's judgement, backed up by the word list above.
  let mood = ["calm", "upset", "angry"].includes(parsed.mood) ? parsed.mood : "calm";
  if (mood === "calm" && COMPLAINT_WORD.test(userText)) mood = "upset";

  // Only trust an order if the item name actually exists in the live catalog —
  // never let the AI invent an order for something that isn't real.
  let order = false;
  let orderItem = "";
  let orderPrice = "";
  if (parsed.order === true && parsed.order_item) {
    // exact name first, then ignoring case, spacing and the kind of dash used
    const matchedRow =
      rows.find((r) => r["Одежды"] === parsed.order_item) ||
      rows.find((r) => normName(r["Одежды"]) === normName(parsed.order_item));
    if (matchedRow) {
      order = true;
      orderItem = matchedRow["Одежды"];
      orderPrice = parsed.order_price || matchedRow["Баасы"] || "";
    } else {
      console.log(`AI tried to order an item not in the catalog, ignoring: ${JSON.stringify(parsed.order_item)}`);
    }
  }

  // Safety net: the AI's own "order" flag isn't fully reliable. If its reply
  // confirms an order (and isn't a question) but no valid item was recorded, work
  // out the item from the conversation: the catalog item mentioned most recently.
  const replyConfirmsOrder = !reply.includes("?") && ORDER_CONFIRMED.test(reply);
  if (!order && replyConfirmsOrder) {
    const recentTexts = [reply, userText, ...[...past].reverse().map((m) => m.content)].slice(0, 8);
    const row = lastMentionedItem(rows, recentTexts);
    if (row) {
      order = true;
      orderItem = row["Одежды"];
      orderPrice = row["Баасы"] || "";
      console.log(`Order item recovered from the conversation: ${JSON.stringify(orderItem)}`);
    }
  }
  // Still no idea which item? Flag a POSSIBLE order so the owner gets an alert anyway.
  const orderUncertain = !order && replyConfirmsOrder;

  past.push(
    { role: "user", content: userText, at: now },
    {
      role: "assistant",
      content: reply,
      at: Date.now(),
      ...(lang && { lang }),
      ...(image && { image }),
      ...(video && { video }),
    }
  );
  await saveHistory(from, past);

  return { reply, image, video, lang, needsOwner: parsed.needs_owner === true || DEFERS_TO_OWNER(reply) || mood !== "calm", mood, order, orderItem, orderPrice, orderUncertain };
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
  const data = await res.json().catch(() => ({}));
  return data.messages?.[0]?.id; // WhatsApp's id for the message we just sent
}

// Shows "typing…" to the customer (and marks their message as read) while we think.
// Purely cosmetic: any failure is ignored.
async function showTyping(messageId) {
  if (!messageId || process.env.HUMAN_PAUSE === "off") return;
  try {
    await sendWhatsApp({ status: "read", message_id: messageId, typing_indicator: { type: "text" } });
  } catch (err) {
    console.log("Typing indicator not shown:", err.message.slice(0, 120));
  }
}

// A real person needs a moment to type. Waits until `startedAt` + a pause that grows with
// the length of the reply (about 1.5 s for a short one, 5 s at most), counting the time
// the AI already took. Set HUMAN_PAUSE=off to disable (tests do this).
async function humanPause(startedAt, text) {
  if (process.env.HUMAN_PAUSE === "off") return;
  const target = Math.min(5000, 1500 + String(text || "").length * 22);
  const left = target - (Date.now() - startedAt);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}

const sendText = (to, body) => sendWhatsApp({ to, type: "text", text: { body } });
const sendImage = (to, link) => sendWhatsApp({ to, type: "image", image: { link } });
const sendVideo = (to, link) => sendWhatsApp({ to, type: "video", video: { link } });

// ---------- Owner answers a customer through the bot ----------
// Every "🔔 customer needs you" alert is remembered (by its WhatsApp message id).
// When the owner REPLIES to that alert (swipe-reply), the owner's words are turned
// into a natural message in the customer's language and sent to the customer from
// the shop number. Starting the reply with "!" sends it word for word instead.
const ALERT_DAYS = 7; // an alert can be answered this long after it was sent
const localAlerts = new Map(); // fallback when Redis is off or unreachable

async function rememberAlert(wamid, customer, question) {
  if (!wamid) return;
  const value = { customer, question, shop: currentShop().code }; // the shop is needed to answer in the right chat
  localAlerts.set(wamid, value);
  if (localAlerts.size > 500) localAlerts.delete(localAlerts.keys().next().value);
  if (useRedis) {
    try {
      await redis(["SET", `alert:${wamid}`, JSON.stringify(value), "EX", String(ALERT_DAYS * 86400)]);
    } catch (err) {
      console.error("Could not save alert link:", err.message);
    }
  }
}

async function lookupAlert(wamid) {
  if (useRedis) {
    try {
      const raw = await redis(["GET", `alert:${wamid}`]);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      console.error("Could not load alert link, using local copy:", err.message);
    }
  }
  return localAlerts.get(wamid) || null;
}

// Turns the owner's short answer into a natural message for the customer.
async function composeOwnerReply(customer, question, ownerText) {
  const past = (await loadHistory(customer)).slice(-6);
  const transcript = past.map((m) => `${m.role === "user" ? "Customer" : "Shop"}: ${m.content}`).join("\n");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You write one WhatsApp message to a customer of a small clothing shop, speaking as the shop, on behalf of the shop owner.
The owner gave you their answer in their own words. Turn it into a short, warm, natural chat message that says exactly what the owner said. Do not add facts, prices, times or promises the owner did not state, and do not leave out anything they said.
Reply in the same language as the customer's question (Russian, Kyrgyz or English). In Russian and Kyrgyz use no Latin-alphabet words, except clothing size labels such as S, M, L, XL.
Never mention AI, a bot, or that the owner passed on a note: just speak as the shop.
Answer ONLY with a JSON object: {"reply": "<message for the customer>", "language": "<ky, ru or en>"}`,
        },
        {
          role: "user",
          content: `Recent chat:\n${transcript || "(none)"}\n\nThe customer's question that needed the owner: ${question}\n\nOwner's answer: ${ownerText}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  return { reply: String(parsed.reply || "").trim(), lang: LANGS.includes(parsed.language) ? parsed.language : undefined };
}

// Sends the owner's answer to the customer and adds it to the customer's chat
// memory, so the bot knows what was said when the customer writes again.
function relayOwnerReply(alert, ownerText) {
  const customer = alert.customer;
  return runInOrder(customer, async () => {
    let reply;
    let lang;
    if (ownerText.startsWith("!")) {
      reply = ownerText.slice(1).trim(); // "!" = send exactly as typed
    } else {
      ({ reply, lang } = await composeOwnerReply(customer, alert.question, ownerText));
    }
    if (!reply) throw new Error("empty reply");
    await sendText(customer, reply);
    const past = await loadHistory(customer);
    past.push({ role: "assistant", content: reply, at: Date.now(), ...(lang && { lang }) });
    await saveHistory(customer, past);
    return reply;
  });
}

// ---------- Bot Status toggle ----------
// The owner can pause/resume the AI by texting the shop number from their own phone
// (the shop's owner_phone). While a shop is paused, its customers get no auto-reply
// at all, so the owner can take over the chat manually from WhatsApp.
const pausedShops = new Set(); // codes of shops whose bot is paused

// If this sender is an owner: which shop their message is about, and the command text.
// An owner of several shops can start a command with a shop code ("nur: статистика");
// without a code, the first shop they own is used.
async function ownerContext(from, text) {
  const id = String(from).replace(/\D/g, "");
  const owned = (await getShops()).filter((s) => s.ownerIds.includes(id));
  if (!owned.length) return null;
  const m = /^([\p{L}\p{N}_]+)\s*[:：]\s*([\s\S]+)$/u.exec(text);
  if (m) {
    const picked = owned.find((s) => s.code === m[1].toLowerCase());
    if (picked) return { shop: picked, text: m[2].trim(), many: owned.length > 1 };
  }
  return { shop: owned[0], text, many: owned.length > 1 };
}

const OFF_CMD = /^(bot\s*off|pause\s*bot|бот\s*(выкл|стоп)|стоп\s*бот)$/i;
const ON_CMD = /^(bot\s*on|resume\s*bot|бот\s*(вкл|включи))$/i;
const STATUS_CMD = /^(bot\s*status|статус\s*бота)$/i;
const STATS_CMD = /^(stats|bot\s*stats|статистика|статистика\s*бота)$/i;
const LOWSTOCK_CMD = /^(low\s*stock|остатки|что\s*заканчивается|заканчивается)$/i;

// Catalog-update commands, texted by the owner. Examples:
//   "бежевый пиджак продан"        -> sets its quantity ("Саны") to 0, i.e. sold out
//   "бежевый пиджак в наличии 5"   -> sets its quantity to 5, i.e. back in stock
//   "цена на бежевый пиджак 2500"  -> sets its price
//   "бежевый пиджак саны 3"        -> sets its quantity
// Stock lives only in the "Саны" column (0 = sold out), there is no separate Бар/жок column.
const SOLD_CMD = /^(.+?)\s+(продан[оа]?|жок)$/i;
const INSTOCK_CMD = /^(.+?)\s+(?:в наличии|снова в наличии|бар)(?:\s+(\d+))?$/i;
const PRICE_CMD_A = /^цена\s+(?:на\s+)?(.+?)\s+(\d+)$/i; // "цена на X 2500"
const PRICE_CMD_B = /^(.+?)\s+цена\s+(\d+)$/i; // "X цена 2500"
const QTY_CMD = /^(.+?)\s+(?:саны|количество)\s+(\d+)$/i; // "X саны 3"

async function postToAppsScript(url, payload) {
  // Apps Script actually RUNS doPost on this first request. The 302 it
  // returns afterward just points to a separate content-delivery URL
  // (script.googleusercontent.com) to fetch the already-computed output —
  // that second URL only accepts GET, so we must not resend our POST body.
  const res = await fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let finalRes = res;
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const location = res.headers.get("location");
    console.log(`Apps Script redirected (${res.status}) to fetch output via GET`);
    if (location) finalRes = await fetch(location, { method: "GET" });
  }

  const text = await finalRes.text();
  console.log(`Apps Script output ${finalRes.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: "bad_response", raw: text.slice(0, 200) };
  }
}

// Which tabs of the master spreadsheet the Apps Script should write to for this shop.
const sheetTabs = () => ({ catalog_gid: currentShop().catalogGid, orders_gid: currentShop().ordersGid });

async function updateCatalog(action, item, value) {
  if (!APPS_SCRIPT_URL) return { ok: false, error: "not_configured" };
  return postToAppsScript(APPS_SCRIPT_URL, { secret: UPDATE_SECRET, action, item, value, ...sheetTabs() });
}

// Logs a confirmed order into the Orders sheet tab and alerts the owner —
// never throws: a failed order log must not affect the customer's reply.
async function recordOrder(customer, item, price) {
  try {
    const result = await postToAppsScript(APPS_SCRIPT_URL, {
      secret: UPDATE_SECRET,
      action: "order",
      customer,
      item,
      value: price,
      ...sheetTabs(),
    });
    console.log(`Order recorded: ${result.ok ? "ok" : "failed - " + result.error} (${item}, ${customer})`);
  } catch (err) {
    console.error("Could not record order:", err.message);
  }

  // Take one piece off this item's stock ("Саны"); never goes below 0.
  const left = await decreaseStock(item);

  const body = [
    shopLine(),
    "🛒 Новый заказ!",
    `Клиент: +${customer}`,
    `Товар: «${item}»`,
    `Цена: ${price} сом`,
    ...(left === null
      ? []
      : [left === 0 ? "📦 Осталось: 0 шт. — товар закончился!" : `📦 Осталось: ${left} шт.${left <= LOW_STOCK_THRESHOLD ? " ⚠️ заканчивается" : ""}`]),
    `Написать клиенту: https://wa.me/${customer}`,
  ].join("\n");
  for (const to of currentShop().orderAlertTo) {
    try {
      await sendText(to, body);
    } catch (err) {
      console.error(`Could not send order alert to ${to}:`, err.message);
    }
  }
}

// First line of every message to an owner, so an owner of several shops sees which one it is about.
const shopLine = () => `🏪 ${currentShop().name}`;

// A customer is upset or angry: send an urgent alert (to the same numbers as the
// regular "needs you" alerts) so the owner steps in quickly. Never throws.
async function notifyUpsetCustomer(customer, message, botReply, mood) {
  const body = [
    shopLine(),
    mood === "angry" ? "🚨 Злой клиент, ответьте как можно скорее!" : "😟 Недовольный клиент, лучше ответить быстро",
    `Клиент: +${customer}`,
    `Сообщение: «${message}»`,
    `Бот ответил: «${botReply}»`,
    `Написать клиенту: https://wa.me/${customer}`,
    "💬 Или ответьте на это сообщение (свайп), и я сам передам ваш ответ клиенту.",
  ].join("\n");
  for (const to of currentShop().alertTo) {
    try {
      const wamid = await sendText(to, body);
      await rememberAlert(wamid, customer, message);
      console.log(`Urgent (${mood}) alert sent to ${to} about customer ${customer}`);
    } catch (err) {
      console.error(`Could not send urgent alert to ${to}:`, err.message);
    }
  }
}

// Lowers the item's "Саны" by 1 in the sheet. Returns the new quantity, or null if
// it couldn't be changed (no number in "Саны", item not found, sheet error). Never throws.
async function decreaseStock(item) {
  try {
    const rows = await fetchCatalog();
    const row = rows.find((r) => r["Одежды"] === item);
    const raw = String(row?.["Саны"] ?? "").trim();
    if (!row || raw === "" || !Number.isFinite(Number(raw))) return null;
    const left = Math.max(0, Number(raw) - 1);
    const result = await updateCatalog("qty", item, left);
    if (!result.ok) {
      console.error(`Could not lower stock for ${JSON.stringify(item)}: ${result.error}`);
      return null;
    }
    catalogCaches.delete(currentShop().catalogGid); // the next message reads the new quantity
    console.log(`Stock for ${JSON.stringify(item)}: ${raw} -> ${left}`);
    return left;
  } catch (err) {
    console.error("Could not lower stock:", err.message);
    return null;
  }
}

// The bot told a customer their order is confirmed but couldn't tell exactly which
// catalog item it was, so nothing was written to the Orders sheet. Alert the owner
// anyway so a real purchase is never missed. Never throws.
async function notifyPossibleOrder(customer, message, botReply) {
  const body = [
    shopLine(),
    "🛒 Похоже, клиент хочет заказать",
    "(бот не смог точно определить товар, поэтому в таблицу заказ не записан. Проверьте переписку.)",
    `Клиент: +${customer}`,
    `Сообщение: «${message}»`,
    `Бот ответил: «${botReply}»`,
    `Написать клиенту: https://wa.me/${customer}`,
    "💬 Или ответьте на это сообщение (свайп), и я сам передам ваш ответ клиенту.",
  ].join("\n");
  for (const to of currentShop().orderAlertTo) {
    try {
      const wamid = await sendText(to, body);
      await rememberAlert(wamid, customer, message);
    } catch (err) {
      console.error(`Could not send possible-order alert to ${to}:`, err.message);
    }
  }
}

function catalogReplyText(result, action) {
  if (result.ok) {
    const actionText = { sold: "ПРОДАН, количество 0", instock: "в наличии, количество обновлено", price: "цена обновлена", qty: "количество обновлено" }[action];
    return `✅ «${result.item}» — ${actionText}.`;
  }
  if (result.error === "not_found") return "❌ Не нашёл такой товар в каталоге. Проверьте название.";
  if (result.error === "ambiguous") return `❓ Нашёл несколько похожих товаров, уточните название:\n${result.matches.join("\n")}`;
  if (result.error === "not_configured") return "⚠️ Обновление каталога через WhatsApp ещё не настроено.";
  return "⚠️ Не удалось обновить каталог, попробуйте ещё раз.";
}

async function tryHandleCatalogCommand(t) {
  let m;
  if ((m = SOLD_CMD.exec(t))) {
    const result = await updateCatalog("qty", m[1].trim(), 0); // sold out = quantity 0
    return catalogReplyText(result, "sold");
  }
  if ((m = INSTOCK_CMD.exec(t))) {
    if (!m[2]) {
      return `❓ Сколько штук «${m[1].trim()}» в наличии? Напишите, например: «${m[1].trim()} в наличии 5»`;
    }
    const result = await updateCatalog("qty", m[1].trim(), Number(m[2]));
    return catalogReplyText(result, "instock");
  }
  if ((m = PRICE_CMD_A.exec(t)) || (m = PRICE_CMD_B.exec(t))) {
    const result = await updateCatalog("price", m[1].trim(), m[2]);
    return catalogReplyText(result, "price");
  }
  if ((m = QTY_CMD.exec(t))) {
    const result = await updateCatalog("qty", m[1].trim(), m[2]);
    return catalogReplyText(result, "qty");
  }
  return null; // not a catalog command
}

// ---------- Handling one incoming message ----------
const seen = new Set(); // Meta sometimes delivers the same message twice

// An owner texted the shop number. Returns true if the message was an owner command
// or an answer to an alert (so it must not be treated as a customer message).
async function handleOwnerMessage(msg, owner) {
  const from = msg.from;
  const rawText = msg.text.body.trim();

  // The owner swipe-replied to an alert ("🔔 customer needs you" etc.): pass the answer on.
  const quotedId = msg.context?.id;
  if (quotedId) {
    const alert = await lookupAlert(quotedId);
    if (alert) {
      const alertShop = (await getShops()).find((s) => s.code === alert.shop) || owner.shop;
      await runAsShop(alertShop, async () => {
        try {
          const sent = await relayOwnerReply(alert, rawText);
          await sendText(from, `✅ Отправил клиенту +${alert.customer}:\n«${sent}»`);
        } catch (err) {
          console.error("Could not pass the owner's answer to the customer:", err.message);
          await sendText(
            from,
            `⚠️ Не удалось отправить клиенту. Возможно, прошло больше 24 часов с его последнего сообщения. Напишите ему напрямую: https://wa.me/${alert.customer}`
          ).catch(() => {});
        }
      });
      return true;
    }
  }

  return runAsShop(owner.shop, async () => {
    const t = owner.text;
    // An owner of several shops sees which shop each reply is about.
    const say = (text) => sendText(from, owner.many ? `🏪 ${owner.shop.name}\n${text}` : text);
    const code = owner.shop.code;

    if (OFF_CMD.test(t)) {
      pausedShops.add(code);
      await say("🔴 Бот приостановлен. Напишите «бот вкл», чтобы снова включить.");
      return true;
    }
    if (ON_CMD.test(t)) {
      pausedShops.delete(code);
      await say("🟢 Бот снова отвечает клиентам.");
      return true;
    }
    if (STATUS_CMD.test(t)) {
      await say(pausedShops.has(code) ? "🔴 Бот выключен." : "🟢 Бот включён.");
      return true;
    }
    if (STATS_CMD.test(t)) {
      const report = await buildStatsReport().catch((err) => {
        console.error("Stats report failed:", err.message);
        return "⚠️ Не удалось собрать статистику, попробуйте ещё раз.";
      });
      await say(report);
      return true;
    }
    if (LOWSTOCK_CMD.test(t)) {
      const { text } = await lowStockReport().catch((err) => {
        console.error("Low stock report failed:", err.message);
        return { text: "⚠️ Не удалось проверить остатки, попробуйте ещё раз." };
      });
      await say(text);
      return true;
    }
    const catalogReply = await tryHandleCatalogCommand(t).catch((err) => {
      console.error("Catalog update failed:", err.message);
      return "⚠️ Не удалось обновить каталог, попробуйте ещё раз.";
    });
    if (catalogReply) {
      await say(catalogReply);
      return true;
    }
    return false;
  });
}

async function handleMessage(msg) {
  if (seen.has(msg.id)) return;
  seen.add(msg.id);
  if (seen.size > 2000) seen.delete(seen.values().next().value);

  const from = msg.from;

  // Owner-only commands and answers to alerts come first
  if (msg.type === "text") {
    const owner = await ownerContext(from, msg.text.body.trim());
    if (owner && (await handleOwnerMessage(msg, owner))) return;
  }

  // Everything else is a customer: find out which shop they are talking to
  const shop = await resolveShopForCustomer(from, msg.type === "text" ? msg.text.body : "");
  return runAsShop(shop, () => handleCustomerMessage(msg, shop));
}

async function handleCustomerMessage(msg, shop) {
  const from = msg.from;

  if (pausedShops.has(shop.code)) {
    console.log(`Bot is paused for ${shop.code}, ignoring message from ${from}`);
    return;
  }

  if (msg.type !== "text") {
    await sendText(from, FIXED.notText[await customerLanguage(from)]);
    return;
  }

  let counted = false; // so one customer message is never counted twice in the stats
  const startedAt = Date.now();
  showTyping(msg.id); // not awaited: "typing…" appears while the AI works
  try {
    const { reply, image, video, needsOwner, mood, order, orderItem, orderPrice, orderUncertain } = await askAI(from, msg.text.body);
    if (reply) {
      await humanPause(startedAt, reply);
      await sendText(from, reply);
    }
    if (image) await sendImage(from, image);
    if (video) await sendVideo(from, video);
    counted = true;
    await bump("messages");
    await bump(needsOwner ? "escalated" : "answered");
    if (order) await bump("orders");
    if (mood !== "calm") await bump("complaints");
    // TEMP DEBUG: log the AI's decisions for every message (shop, needs_owner, order, mood).
    console.log(`shop=${shop.code} needsOwner=${needsOwner} for message from ${from}: "${msg.text.body}"`);
    console.log(`order=${order} item=${JSON.stringify(orderItem)} price=${JSON.stringify(orderPrice)} for message from ${from}: "${msg.text.body}"`);
    console.log(`mood=${mood} for message from ${from}`);
    // An upset or angry customer gets the urgent alert instead of the regular one (never both)
    if (mood !== "calm") await notifyUpsetCustomer(from, msg.text.body, reply, mood);
    else if (needsOwner) await notifyOwner(from, msg.text.body, reply);
    if (order) await recordOrder(from, orderItem, orderPrice);
    else if (orderUncertain) await notifyPossibleOrder(from, msg.text.body, reply);
  } catch (err) {
    console.error("Failed to answer:", err.message);
    if (!counted) await bump("messages");
    await bump("errors");
    const lang = await customerLanguage(from, msg.text.body).catch(() => "ru");
    await sendText(from, FIXED.checking[lang]).catch(() => {});
    await notifyOwner(from, msg.text.body, FIXED.checking[lang], "⚠️ Бот не смог ответить (ошибка).");
  }
}

// ---------- Owner alerts ----------
// When the bot can't answer and promises the owner will follow up, text the owner
// so a customer is never left waiting. Never throws: a failed alert must not
// affect the customer's reply. Each shop has its own alert numbers: alertTo for
// "needs you" alerts, orderAlertTo for new orders.

async function notifyOwner(customer, question, botReply, note = "") {
  const shop = currentShop();
  if (!shop.alertTo.length) return;
  const body = [
    shopLine(),
    "🔔 Клиенту нужен ваш ответ",
    note,
    `Клиент: +${customer}`,
    `Вопрос: «${question}»`,
    `Бот ответил: «${botReply}»`,
    `Написать клиенту: https://wa.me/${customer}`,
    "💬 Или ответьте на это сообщение (свайп), и я сам передам ваш ответ клиенту.",
  ]
    .filter(Boolean)
    .join("\n");
  for (const to of shop.alertTo) {
    try {
      const wamid = await sendText(to, body);
      await rememberAlert(wamid, customer, question);
      console.log(`Alert sent to ${to} about customer ${customer} (${shop.code})`);
    } catch (err) {
      console.error(
        `Could not alert ${to}. That number must have messaged the shop number in the last 24 hours (and, on Meta's test number, be in the allowed recipients list) —`,
        err.message
      );
    }
  }
}

// ---------- Low stock + scheduled jobs ----------
// Items whose quantity ("Саны" column) is at or below this number count as running low.
const LOW_STOCK_THRESHOLD = Number(process.env.LOW_STOCK_THRESHOLD) || 2;

// Returns { text, count } for the current shop. count is 0 when everything is well stocked.
async function lowStockReport() {
  const rows = await fetchCatalog();
  const low = rows
    .map((r) => ({ name: String(r["Одежды"] || "").trim(), qty: String(r["Саны"] ?? "").trim() }))
    .filter((r) => r.name && r.qty !== "" && Number.isFinite(Number(r.qty)) && Number(r.qty) <= LOW_STOCK_THRESHOLD)
    .sort((a, b) => Number(a.qty) - Number(b.qty));
  if (!low.length) return { text: "✅ Всё в наличии, ничего не заканчивается.", count: 0 };
  const lines = low.map((r) => (Number(r.qty) === 0 ? `• ${r.name} — закончилось` : `• ${r.name} — осталось ${r.qty} шт.`));
  return { text: `📦 Заканчивается товар (${LOW_STOCK_THRESHOLD} шт. и меньше):\n\n${lines.join("\n")}`, count: low.length };
}

// Text every alert number of the current shop. Never throws.
async function alertOwners(text) {
  for (const to of currentShop().alertTo) {
    try {
      await sendText(to, text);
      console.log(`Scheduled message sent to ${to}`);
    } catch (err) {
      console.error(`Could not message ${to} (they must have messaged the shop number in the last 24 hours):`, err.message);
    }
  }
}

// Runs one scheduled task ("lowstock" or "summary") for every shop, each in its own shop context.
async function runScheduledTask(task) {
  if (task !== "lowstock" && task !== "summary") {
    console.warn(`Unknown scheduled task: ${task}`);
    return;
  }
  for (const shop of await getShops()) {
    await runAsShop(shop, async () => {
      try {
        if (task === "lowstock") {
          const { text, count } = await lowStockReport();
          if (count) await alertOwners(`${shopLine()}\n${text}`); // stay quiet when there is nothing to report
          console.log(`Scheduled lowstock for ${shop.code}: ${count} item(s) low`);
        } else {
          const today = await loadDay(bishkekDay());
          await alertOwners(`${shopLine()}\n🌙 Итоги дня\n\n${statsBlock(today)}`);
          console.log(`Scheduled summary sent for ${shop.code}`);
        }
      } catch (err) {
        console.error(`Scheduled ${task} failed for ${shop.code}:`, err.message);
      }
    });
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

// An outside timer (cron-job.org) calls this at set times, e.g.
//   https://YOUR-APP.onrender.com/cron/lowstock?key=UPDATE_SECRET   (morning)
//   https://YOUR-APP.onrender.com/cron/summary?key=UPDATE_SECRET    (evening)
// Calling it also wakes the free Render server if it was asleep. We answer right
// away and do the work afterwards so the timer never waits on a slow start.
app.get("/cron/:task", (req, res) => {
  if (!UPDATE_SECRET || req.query.key !== UPDATE_SECRET) return res.sendStatus(403);
  res.status(200).send("ok");
  runScheduledTask(req.params.task).catch((err) => console.error("Scheduled task failed:", err.message));
});

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
  getShops()
    .then((shops) =>
      console.log(`Shops: ${shops.map((x) => `${x.code}${x.isDefault ? " (default)" : ""} alerts to ${x.alertTo.join(",") || "nobody"}`).join("; ")}`)
    )
    .catch((err) => console.error("Could not load shops at startup:", err.message));
  console.log(
    useRedis
      ? "Chat memory: saved in Upstash (remembered across days and restarts)."
      : "Chat memory: UPSTASH_REDIS_REST_URL/TOKEN not set — chats are forgotten on every restart."
  );
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Listening on port ${port}`));
}

module.exports = { app, handleMessage, buildSystemPrompt, ASKS_FOR_MEDIA };
