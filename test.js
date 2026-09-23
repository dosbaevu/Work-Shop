// Local test harness: mocks Google Sheets, OpenAI and the WhatsApp Graph API
// so we can exercise server.js logic without any real credentials.

process.env.VERIFY_TOKEN = "aiperi2026";
process.env.WHATSAPP_TOKEN = "test-whatsapp-token";
process.env.PHONE_NUMBER_ID = "1356197224240389";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.SHEET_ID = "fake-sheet-id";
process.env.APP_SECRET = ""; // skip signature check for local test
process.env.OWNER_PHONE = "996700111222"; // shop owner's own number, for the Bot Status toggle

const assert = require("assert");
const http = require("http");

const CSV = `Item,Sizes,Colors,Price,Stock,Photo,Video
Beige oversized blazer,"S, M, L","beige, black",2200,all sizes except black in L,,https://placehold.co/mp4?text=Blazer+Video
Denim jacket (blue),"S, M, L",blue,1900,all sizes,https://placehold.co/400x600/1a56db/ffffff?text=Blue+Jacket,
Denim jacket (white),"S, M, L",white,1900,all sizes,https://placehold.co/400x600/e5e5e5/1a1a1a?text=White+Jacket,
`;

// ---- Mock global fetch ----
const calls = { openai: [], whatsapp: [] };
const originalFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);

  if (u.includes("docs.google.com")) {
    return { ok: true, text: async () => CSV };
  }

  if (u.includes("api.openai.com")) {
    const body = JSON.parse(opts.body);
    calls.openai.push(body);
    const userMsg = body.messages[body.messages.length - 1].content;

    let reply = { reply: "", image_url: "", video_url: "" };
    if (/video/i.test(userMsg) && /blazer/i.test(userMsg)) {
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
