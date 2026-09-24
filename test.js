// Local test harness: mocks Google Sheets, OpenAI and the WhatsApp Graph API
// so we can exercise server.js logic without any real credentials.

process.env.VERIFY_TOKEN = "aiperi2026";
process.env.WHATSAPP_TOKEN = "test-whatsapp-token";
process.env.PHONE_NUMBER_ID = "1356197224240389";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.SHEET_ID = "fake-sheet-id";
process.env.APP_SECRET = ""; // skip signature check for local test
process.env.OWNER_PHONE = "996700111222"; // shop owner's own number, for the Bot Status toggle
process.env.UPSTASH_REDIS_REST_URL = "https://fake-redis.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-redis-token";

const assert = require("assert");
const http = require("http");

const CSV = `Item,Sizes,Colors,Price,Stock,Photo,Video
Beige oversized blazer,"S, M, L","beige, black",2200,all sizes except black in L,,https://placehold.co/mp4?text=Blazer+Video
Denim jacket (blue),"S, M, L",blue,1900,all sizes,https://placehold.co/400x600/1a56db/ffffff?text=Blue+Jacket,
Denim jacket (white),"S, M, L",white,1900,all sizes,https://placehold.co/400x600/e5e5e5/1a1a1a?text=White+Jacket,
`;

// ---- Mock global fetch ----
const calls = { openai: [], whatsapp: [] };
const redisStore = new Map(); // stands in for the Upstash database; survives a simulated restart
const redisState = { down: false };
const originalFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);

  if (u.includes("fake-redis.upstash.io")) {
    if (redisState.down) return { ok: false, status: 503, json: async () => ({ error: "unavailable" }) };
    assert.strictEqual(opts.headers.Authorization, "Bearer test-redis-token");
    const [cmd, key, value] = JSON.parse(opts.body);
    if (cmd === "GET") return { ok: true, json: async () => ({ result: redisStore.get(key) ?? null }) };
    if (cmd === "SET") {
      redisStore.set(key, value);
      return { ok: true, json: async () => ({ result: "OK" }) };
    }
    throw new Error("Unexpected Redis command " + cmd);
  }

  if (u.includes("docs.google.com")) {
    return { ok: true, text: async () => CSV };
  }

  if (u.includes("api.openai.com")) {
    const body = JSON.parse(opts.body);
    calls.openai.push(body);
    const userMsg = body.messages[body.messages.length - 1].content;

    let reply = { reply: "", image_url: "", video_url: "" };
    if (/[ңөү]|канча|барбы/i.test(userMsg)) {
      reply = { reply: "Саламатсызбы! Ооба, бежевый пиджак бар, баасы 2200 сом.", image_url: "", video_url: "", language: "ky" };
    } else if (/video/i.test(userMsg) && /blazer/i.test(userMsg)) {
      reply = {
        reply: "Here's a video of the beige blazer.",
        image_url: "",
        video_url: "https://placehold.co/mp4?text=Blazer+Video",
      };
    } else if (/blazer/i.test(userMsg) && /english|stock/i.test(userMsg)) {
      reply = { reply: "Yes, the beige blazer is in stock in S, M and L. Price 2200 KGS.", image_url: "", video_url: "" };
    } else if (/пиджак/i.test(userMsg)) {
      reply = { reply: "Здравствуйте! Да, бежевый пиджак в наличии в размерах S, M и L. Цена 2200 KGS.", image_url: "", video_url: "" };
    } else if (/blue jacket|синюю куртку/i.test(userMsg)) {
      reply = {
        reply: "Here's the blue denim jacket, 1900 KGS, all sizes in stock.",
        image_url: "https://placehold.co/400x600/1a56db/ffffff?text=Blue+Jacket",
        video_url: "",
      };
    } else if (/shoes|обувь/i.test(userMsg)) {
      reply = { reply: "We don't carry shoes right now, sorry!", image_url: "", video_url: "" };
    } else {
      reply = { reply: "Let me check with the owner and get back to you.", image_url: "", video_url: "" };
    }

    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }),
    };
  }

  if (u.includes("graph.facebook.com")) {
    const body = JSON.parse(opts.body);
    calls.whatsapp.push(body);
    return { ok: true, json: async () => ({ success: true }) };
  }

  throw new Error("Unexpected fetch to " + u);
};

const { app, handleMessage } = require("./server.js");

async function run() {
  // ---- 1. GET /webhook verification ----
  const server = app.listen(0);
  const port = server.address().port;

  const verifyRes = await httpGet(
    `http://localhost:${port}/webhook?hub.mode=subscribe&hub.verify_token=aiperi2026&hub.challenge=CHALLENGE123`
  );
  assert.strictEqual(verifyRes.status, 200);
  assert.strictEqual(verifyRes.body, "CHALLENGE123");
  console.log("PASS: webhook GET verification returns the challenge");

  const badVerifyRes = await httpGet(
    `http://localhost:${port}/webhook?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=X`
  );
  assert.strictEqual(badVerifyRes.status, 403);
  console.log("PASS: webhook GET verification rejects wrong token");

  // ---- 2. English question -> English reply, no image ----
  await handleMessage({ id: "m1", from: "996502282505", type: "text", text: { body: "Do you have the beige blazer in stock, english please" } });
  assert.strictEqual(calls.whatsapp.length, 1);
  assert.strictEqual(calls.whatsapp[0].type, "text");
  assert.ok(calls.whatsapp[0].text.body.includes("2200"));
  console.log("PASS: English question produces English text reply with correct price");

  // ---- 3. Russian question -> Russian reply, proper greeting ----
  await handleMessage({ id: "m2", from: "996502282505", type: "text", text: { body: "У вас есть бежевый пиджак?" } });
  const lastText = calls.whatsapp[calls.whatsapp.length - 1];
  assert.ok(lastText.text.body.startsWith("Здравствуйте"));
  console.log("PASS: Russian question gets Russian greeting, not 'Hi'");

  // ---- 4. Image match: blue jacket sends text + image ----
  calls.whatsapp.length = 0;
  await handleMessage({ id: "m3", from: "996502282505", type: "text", text: { body: "Can I see the blue jacket?" } });
  assert.strictEqual(calls.whatsapp.length, 2);
  assert.strictEqual(calls.whatsapp[0].type, "text");
  assert.strictEqual(calls.whatsapp[1].type, "image");
  assert.strictEqual(calls.whatsapp[1].image.link, "https://placehold.co/400x600/1a56db/ffffff?text=Blue+Jacket");
  console.log("PASS: image request sends text then the correct image, in order");

  // ---- 5. Item not in catalog ----
  calls.whatsapp.length = 0;
  await handleMessage({ id: "m4", from: "996502282505", type: "text", text: { body: "Do you sell shoes?" } });
  assert.strictEqual(calls.whatsapp.length, 1);
  assert.ok(/don't carry shoes/i.test(calls.whatsapp[0].text.body));
  console.log("PASS: out-of-catalog question doesn't invent an answer");

  // ---- 6. Duplicate message id is ignored (Meta sometimes redelivers) ----
  calls.whatsapp.length = 0;
  const dup = { id: "m4", from: "996502282505", type: "text", text: { body: "Do you sell shoes?" } };
  await handleMessage(dup);
  await handleMessage(dup);
  assert.strictEqual(calls.whatsapp.length, 0);
  console.log("PASS: duplicate message id is not answered twice");

  // ---- 7. Non-text message gets the "please type" fallback, no crash ----
  calls.whatsapp.length = 0;
  await handleMessage({ id: "m5", from: "996502282505", type: "audio", audio: { id: "x" } });
  assert.strictEqual(calls.whatsapp.length, 1);
  assert.ok(/напишите вопрос текстом/i.test(calls.whatsapp[0].text.body));
  console.log("PASS: voice/audio message gets graceful fallback, not silently dropped");

  // ---- 8. Malformed OpenAI JSON doesn't crash the handler ----
  const savedFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes("api.openai.com")) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: "not json {" } }] }) };
    }
    return savedFetch(url, opts);
  };
  calls.whatsapp.length = 0;
  await handleMessage({ id: "m6", from: "996502282505", type: "text", text: { body: "anything" } });
  assert.strictEqual(calls.whatsapp.length, 1);
  assert.ok(/уточню у владельца/i.test(calls.whatsapp[0].text.body));
  console.log("PASS: malformed AI output falls back to a safe message instead of crashing");
  global.fetch = savedFetch;

  // ---- 9. POST /webhook full round trip through Express ----
  calls.whatsapp.length = 0;
  const payload = {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messages: [{ id: "m7", from: "996502282505", type: "text", text: { body: "Do you sell shoes?" } }],
            },
          },
        ],
      },
    ],
  };
  const postRes = await httpPost(`http://localhost:${port}/webhook`, payload);
  assert.strictEqual(postRes.status, 200);
  await new Promise((r) => setTimeout(r, 50)); // let the async handler finish
  assert.strictEqual(calls.whatsapp.length, 1);
  console.log("PASS: full POST /webhook round trip processes the message");

  // ---- 10. Video request: text + video, matched from the sheet's Video column ----
  calls.whatsapp.length = 0;
  await handleMessage({ id: "m8", from: "996502282505", type: "text", text: { body: "Can I get a video of the blazer?" } });
  assert.strictEqual(calls.whatsapp.length, 2);
  assert.strictEqual(calls.whatsapp[0].type, "text");
  assert.strictEqual(calls.whatsapp[1].type, "video");
  assert.strictEqual(calls.whatsapp[1].video.link, "https://placehold.co/mp4?text=Blazer+Video");
  console.log("PASS: video request sends text then the correct video, in order");

  // ---- 11. Bot Status toggle: owner can pause/resume auto-replies ----
  calls.whatsapp.length = 0;
  const OWNER = "996700111222";
  await handleMessage({ id: "m9", from: OWNER, type: "text", text: { body: "bot off" } });
  assert.strictEqual(calls.whatsapp.length, 1);
  assert.ok(/приостановлен/i.test(calls.whatsapp[0].text.body));
  console.log("PASS: owner 'bot off' pauses the bot and gets a confirmation");

  calls.whatsapp.length = 0;
  await handleMessage({ id: "m10", from: "996502282505", type: "text", text: { body: "Do you have the blazer?" } });
  assert.strictEqual(calls.whatsapp.length, 0);
  console.log("PASS: while paused, a customer message gets no auto-reply at all");

  calls.whatsapp.length = 0;
  await handleMessage({ id: "m11", from: OWNER, type: "text", text: { body: "bot status" } });
  assert.strictEqual(calls.whatsapp.length, 1);
  assert.ok(/выключен/i.test(calls.whatsapp[0].text.body));
  console.log("PASS: owner 'bot status' reports the current state");

  calls.whatsapp.length = 0;
  await handleMessage({ id: "m12", from: OWNER, type: "text", text: { body: "bot on" } });
  assert.strictEqual(calls.whatsapp.length, 1);
  assert.ok(/снова отвечает/i.test(calls.whatsapp[0].text.body));
  console.log("PASS: owner 'bot on' resumes the bot and gets a confirmation");

  calls.whatsapp.length = 0;
  await handleMessage({ id: "m13", from: "996502282505", type: "text", text: { body: "Do you have the blazer, english please" } });
  assert.strictEqual(calls.whatsapp.length, 1);
  assert.ok(calls.whatsapp[0].text.body.includes("2200"));
  console.log("PASS: after resuming, customers get normal auto-replies again");

  calls.whatsapp.length = 0;
  await handleMessage({ id: "m14", from: "996502282505", type: "text", text: { body: "bot off" } });
  assert.strictEqual(calls.whatsapp.length, 1); // treated as a normal customer question, not a command
  console.log("PASS: 'bot off' from a non-owner number is not treated as a command");

  // ---- 12. Chat memory is saved to the database ----
  const CUSTOMER = "996555000111";
  await handleMessage({ id: "m20", from: CUSTOMER, type: "text", text: { body: "У вас есть бежевый пиджак?" } });
  const saved = JSON.parse(redisStore.get(`chat:${CUSTOMER}`));
  assert.strictEqual(saved.length, 2);
  assert.strictEqual(saved[0].content, "У вас есть бежевый пиджак?");
  assert.strictEqual(saved[1].role, "assistant");
  assert.ok(saved[0].at > 0);
  console.log("PASS: conversation is saved to the database with timestamps");

  // ---- 13. Memory survives a server restart ----
  delete require.cache[require.resolve("./server.js")];
  const restarted = require("./server.js"); // fresh server: its own in-memory copy is empty
  calls.openai.length = 0;
  await restarted.handleMessage({ id: "m21", from: CUSTOMER, type: "text", text: { body: "а сколько он стоит?" } });
  const sentAfterRestart = calls.openai[0].messages.map((m) => m.content);
  assert.ok(sentAfterRestart.includes("У вас есть бежевый пиджак?"));
  assert.ok(!calls.openai[0].messages.some((m) => m.role === "system" && /earlier conversation/.test(m.content)));
  console.log("PASS: after a restart the bot still sees the earlier messages (no 'new visit' note within 3 hours)");

  // ---- 14. Coming back the next day: AI is told it's an earlier conversation ----
  const yesterday = Date.now() - 24 * 3600 * 1000;
  const aged = JSON.parse(redisStore.get(`chat:${CUSTOMER}`)).map((m) => ({ ...m, at: yesterday }));
  redisStore.set(`chat:${CUSTOMER}`, JSON.stringify(aged));
  calls.openai.length = 0;
  await restarted.handleMessage({ id: "m22", from: CUSTOMER, type: "text", text: { body: "Здравствуйте, я вчера спрашивала про пиджак" } });
  const msgs = calls.openai[0].messages;
  const note = msgs[msgs.length - 2];
  assert.strictEqual(note.role, "system");
  assert.ok(/earlier conversation/.test(note.content));
  assert.ok(msgs.some((m) => m.content === "У вас есть бежевый пиджак?"));
  assert.ok(msgs.every((m) => !("at" in m)), "timestamps must not be sent to OpenAI");
  console.log("PASS: next-day message includes yesterday's chat plus an 'earlier conversation' note");

  // ---- 15. Only the most recent 30 messages are kept ----
  const long = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `old ${i}`, at: Date.now() }));
  redisStore.set(`chat:${CUSTOMER}`, JSON.stringify(long));
  await restarted.handleMessage({ id: "m23", from: CUSTOMER, type: "text", text: { body: "ещё вопрос" } });
  assert.strictEqual(JSON.parse(redisStore.get(`chat:${CUSTOMER}`)).length, 30);
  console.log("PASS: memory is capped at the last 30 messages");

  // ---- 16. Database outage doesn't stop replies ----
  redisState.down = true;
  calls.whatsapp.length = 0;
  await restarted.handleMessage({ id: "m24", from: CUSTOMER, type: "text", text: { body: "Do you sell shoes?" } });
  assert.strictEqual(calls.whatsapp.length, 1);
  assert.ok(/don't carry shoes/i.test(calls.whatsapp[0].text.body));
  redisState.down = false;
  console.log("PASS: if the memory database is down, the customer still gets a normal reply");

  // ---- 17. Two quick messages from one customer don't overwrite each other's memory ----
  const server2 = restarted.app.listen(0);
  const QUICK = "996555000222";
  await httpPost(`http://localhost:${server2.address().port}/webhook`, {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { id: "m30", from: QUICK, type: "text", text: { body: "Здравствуйте" } },
                { id: "m31", from: QUICK, type: "text", text: { body: "Do you sell shoes?" } },
              ],
            },
          },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 100));
  const quick = JSON.parse(redisStore.get(`chat:${QUICK}`));
  assert.deepStrictEqual(
    quick.map((m) => m.content).filter((_, i) => i % 2 === 0),
    ["Здравствуйте", "Do you sell shoes?"]
  );
  server2.close();
  console.log("PASS: back-to-back messages are handled in order and both are remembered");

  // ---- 18. Kyrgyz: prompt tells the AI to answer Kyrgyz in Kyrgyz ----
  const prompt = restarted.buildSystemPrompt([]);
  assert.ok(/never answer a Kyrgyz message in Russian/.test(prompt));
  assert.ok(/"language": "<ky, ru or en>"/.test(prompt));
  console.log("PASS: system prompt has the Kyrgyz/Russian language rule and asks for the reply language");

  // ---- 19. Kyrgyz reply is sent and the customer's language is remembered ----
  const KG = "996555000333";
  calls.whatsapp.length = 0;
  await restarted.handleMessage({ id: "m40", from: KG, type: "text", text: { body: "Салам, бежевый пиджак барбы? Баасы канча?" } });
  assert.ok(calls.whatsapp[0].text.body.startsWith("Саламатсызбы"));
  const kgSaved = JSON.parse(redisStore.get(`chat:${KG}`));
  assert.strictEqual(kgSaved[1].lang, "ky");
  console.log("PASS: Kyrgyz question gets the Kyrgyz reply and the language is saved");

  // ---- 20. Voice note from a Kyrgyz-speaking customer gets the Kyrgyz fixed message ----
  calls.whatsapp.length = 0;
  await restarted.handleMessage({ id: "m41", from: KG, type: "audio", audio: { id: "x" } });
  assert.ok(/текст менен жазып/.test(calls.whatsapp[0].text.body));
  console.log("PASS: voice note from a Kyrgyz speaker gets the 'please type' message in Kyrgyz");

  // ---- 21. Voice note from a brand-new customer defaults to Russian ----
  calls.whatsapp.length = 0;
  await restarted.handleMessage({ id: "m42", from: "996555000444", type: "audio", audio: { id: "x" } });
  assert.ok(/напишите вопрос текстом/.test(calls.whatsapp[0].text.body));
  console.log("PASS: voice note from a new customer gets the Russian message");

  // ---- 22. If the AI fails on a Kyrgyz message, the fallback is in Kyrgyz ----
  const beforeBroken = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes("api.openai.com")) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: "not json {" } }] }) };
    }
    return beforeBroken(url, opts);
  };
  calls.whatsapp.length = 0;
  await restarted.handleMessage({ id: "m43", from: "996555000555", type: "text", text: { body: "Көйнөктүн баасы канча?" } });
  assert.ok(/ээсинен тактап/.test(calls.whatsapp[0].text.body));
  calls.whatsapp.length = 0;
  await restarted.handleMessage({ id: "m44", from: "996555000666", type: "text", text: { body: "Сколько стоит платье?" } });
  assert.ok(/уточню у владельца/.test(calls.whatsapp[0].text.body));
  global.fetch = beforeBroken;
  console.log("PASS: error fallback follows the customer's language (Kyrgyz / Russian)");

  // ---- 23. Photo is not re-sent on every follow-up (the AI keeps attaching it) ----
  const PHOTO_FAN = "996555000777";
  const BLUE = "https://placehold.co/400x600/1a56db/ffffff?text=Blue+Jacket";
  calls.whatsapp.length = 0;
  await restarted.handleMessage({ id: "m50", from: PHOTO_FAN, type: "text", text: { body: "Can I see the blue jacket?" } });
  assert.deepStrictEqual(calls.whatsapp.map((c) => c.type), ["text", "image"]);

  calls.whatsapp.length = 0;
  await restarted.handleMessage({ id: "m51", from: PHOTO_FAN, type: "text", text: { body: "What sizes does the blue jacket come in?" } });
  assert.deepStrictEqual(calls.whatsapp.map((c) => c.type), ["text"]);
  calls.whatsapp.length = 0;
  await restarted.handleMessage({ id: "m52", from: PHOTO_FAN, type: "text", text: { body: "And XL for the blue jacket?" } });
  assert.deepStrictEqual(calls.whatsapp.map((c) => c.type), ["text"]);
  console.log("PASS: follow-up questions about the same item don't re-send its photo");

  calls.openai.length = 0;
  calls.whatsapp.length = 0;
  await restarted.handleMessage({ id: "m53", from: PHOTO_FAN, type: "text", text: { body: "Show me the blue jacket photo again" } });
  assert.deepStrictEqual(calls.whatsapp.map((c) => c.type), ["text", "image"]);
  assert.strictEqual(calls.whatsapp[1].image.link, BLUE);
  console.log("PASS: asking to see it again does re-send the photo");

  // The AI sees its earlier replies in its own JSON format, including the photo it sent
  const earlier = calls.openai[0].messages.filter((m) => m.role === "assistant").map((m) => JSON.parse(m.content));
  assert.strictEqual(earlier[0].image_url, BLUE);
  assert.strictEqual(earlier[1].image_url, "");
  console.log("PASS: the AI can see which photos it already sent earlier in the chat");

  // Russian/Kyrgyz "show me" words are recognised
  for (const text of ["покажите фото", "скиньте фотку", "как выглядит?", "сүрөтүн көрсөтүңүзчү"]) {
    assert.ok(restarted.ASKS_FOR_MEDIA.test(text), text);
  }
  for (const text of ["а какие размеры есть", "а XL есть?", "баасы канча?"]) {
    assert.ok(!restarted.ASKS_FOR_MEDIA.test(text), text);
  }
  console.log("PASS: 'show me' words in Russian/Kyrgyz are recognised; size/price questions are not");

  server.close();
  global.fetch = originalFetch;
  console.log("\nALL TESTS PASSED");
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

function httpPost(url, jsonBody) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(jsonBody));
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": data.length } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

run().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
