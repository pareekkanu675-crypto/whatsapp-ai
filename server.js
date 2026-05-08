require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cors = require("cors");
const QRCode = require("qrcode");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "secret";

app.use("/qr", express.static("public"));

// ================= DATABASE =================
function load(file, fallback) {
  try {
    return fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file))
      : fallback;
  } catch {
    return fallback;
  }
}

let users = load("users.json", {});
let clients = load("clients.json", {});
let leads = load("leads.json", {});
let bookings = load("bookings.json", []);
let memory = load("memory.json", {});
let revenue = load("revenue.json", []);
let followups = load("followups.json", []);

function saveAll() {
  fs.writeFileSync("users.json", JSON.stringify(users, null, 2));
  fs.writeFileSync("clients.json", JSON.stringify(clients, null, 2));
  fs.writeFileSync("leads.json", JSON.stringify(leads, null, 2));
  fs.writeFileSync("bookings.json", JSON.stringify(bookings, null, 2));
  fs.writeFileSync("memory.json", JSON.stringify(memory, null, 2));
  fs.writeFileSync("revenue.json", JSON.stringify(revenue, null, 2));
  fs.writeFileSync("followups.json", JSON.stringify(followups, null, 2));
}

// ================= BASIC =================
app.get("/", (req, res) => res.send("🚀 ULTRA SaaS Running"));
app.get("/privacy", (req, res) => res.send("Privacy Policy"));
app.get("/terms", (req, res) => res.send("Terms"));
app.post("/delete", (req, res) => res.send({ success: true }));

// ================= HELPERS =================
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a, b) {
  let matches = 0;

  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) matches++;
  }

  return matches / Math.max(a.length, b.length);
}

function detectService(msg) {
  const t = normalize(msg);

  const map = {
    haircut: ["haircut", "cut", "fade", "trim", "baal"],
    beard: ["beard", "daadhi", "shave"],
    facial: ["facial", "spa", "face", "skin"]
  };

  for (let s in map) {
    if (map[s].some(w => t.includes(w))) return s;
  }

  return null;
}

function detectDate(msg) {
  const text = msg.toLowerCase();

  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);

  if (text.includes("kal") || text.includes("tomorrow")) {
    return tomorrow.toISOString().split("T")[0];
  }

  return today.toISOString().split("T")[0];
}

function reply(session, en, hi, hinglish) {
  if (session.lang === "hi") return hi;
  if (session.lang === "hinglish") return hinglish;
  return en;
}

// ================= SMART LEAD ENGINE =================
const salonKeywords = [
  "haircut",
  "hair cut",
  "fade",
  "beard",
  "trim",
  "barber",
  "salon",
  "hairstyle",
  "spa",
  "facial",
  "grooming"
];

const intentKeywords = [
  "price",
  "cost",
  "rate",
  "kitna",
  "how much",
  "near me",
  "nearby",
  "book",
  "appointment",
  "today",
  "now"
];

function detectSalon(text) {
  const t = normalize(text);
  let score = 0;

  for (let word of salonKeywords) {
    if (t.includes(word)) score += 2;
    if (similarity(t, word) > 0.6) score += 1;
  }

  return score;
}

function detectIntent(text) {
  const t = normalize(text);
  let score = 0;

  for (let word of intentKeywords) {
    if (t.includes(word)) score += 2;
    if (similarity(t, word) > 0.6) score += 1;
  }

  return score;
}

function analyzeLead(text) {
  const salonScore = detectSalon(text);
  const intentScore = detectIntent(text);

  let finalScore = salonScore + intentScore;

  if (/near me|nearby/.test(text)) finalScore += 3;
  if (/today|now/.test(text)) finalScore += 2;
  if (/book|appointment/.test(text)) finalScore += 3;

  return {
    salonScore,
    intentScore,
    finalScore
  };
}

function isSmartLead(text) {
  const result = analyzeLead(text);
  return result.finalScore >= 8;
}

// ================= AUTH =================
app.post("/api/register", async (req, res) => {
  const { email, password, businessName, upi, ownerPhone } = req.body;

  const hash = await bcrypt.hash(password, 10);

  users[email] = {
    password: hash
  };

  clients[email] = {
    name: businessName,
    ownerPhone,
    upi,
    services: {
      haircut: 300,
      facial: 800,
      beard: 200
    },
    timings: "10 AM - 8 PM",
    availableSlots: ["10:00", "12:00", "14:00", "16:00"],
    phone_number_id: process.env.PHONE_NUMBER_ID,
    trialStart: Date.now(),
    trialEnds: Date.now() + 30 * 24 * 60 * 60 * 1000,
    isPaid: false
  };

  saveAll();

  res.send({ success: true });
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  const user = users[email];

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.send({ success: false });
  }

  const token = jwt.sign({ email }, JWT_SECRET);

  res.send({
    success: true,
    token
  });
});

function auth(req, res, next) {
  const token = req.headers.authorization;

  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.sendStatus(403);

    req.email = decoded.email;
    next();
  });
}

// ================= DASHBOARD =================
app.get("/api/client-data", auth, (req, res) => {
  const email = req.email;

  const userBookings = bookings.filter(
    b => b.businessId === email
  );

  res.send({
    leads: (leads[email] || []).length,
    bookings: userBookings.length,
    revenue: userBookings.reduce(
      (s, b) => s + (clients[email].services[b.service] || 0),
      0
    ),
    services: clients[email].services,
    upi: clients[email].upi
  });
});

app.get("/api/analytics", auth, (req, res) => {
  const email = req.email;

  const userBookings = bookings.filter(
    b => b.businessId === email
  );

  const totalRevenue = userBookings.reduce(
    (sum, b) => sum + (clients[email].services[b.service] || 0),
    0
  );

  res.send({
    totalBookings: userBookings.length,
    totalRevenue,
    conversionRate:
      (userBookings.length / ((leads[email] || []).length || 1)) * 100
  });
});

app.get("/api/dashboard-advanced", auth, (req, res) => {
  const email = req.email;

  const userBookings = bookings.filter(
    b => b.businessId === email
  );

  const userRevenue = revenue.filter(
    r => r.businessId === email
  );

  const revenueByDay = {};

  userRevenue.forEach(r => {
    const day = r.date.split("T")[0];
    revenueByDay[day] = (revenueByDay[day] || 0) + r.amount;
  });

  const serviceStats = {};

  userRevenue.forEach(r => {
    serviceStats[r.service] =
      (serviceStats[r.service] || 0) + r.amount;
  });

  res.send({
    totalBookings: userBookings.length,
    totalRevenue: userRevenue.reduce((s, r) => s + r.amount, 0),
    customers: userBookings,
    revenueByDay,
    serviceStats
  });
});

// ================= QR =================
async function generateQRImage(upi, name, amount, service) {
  const link = `upi://pay?pa=${upi}&pn=${name}&am=${amount}&tn=${service}&cu=INR`;

  const fileName = `qr_${Date.now()}.png`;
  const filePath = path.join(__dirname, "public", fileName);

  await QRCode.toFile(filePath, link);

  return `${process.env.BASE_URL}/qr/${fileName}`;
}

// ================= OWNER NOTIFY =================
async function notifyOwner(client, booking) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${client.phone_number_id}/messages`,
      {
        messaging_product: "whatsapp",
        to: client.ownerPhone,
        text: {
          body:
            `📢 New Booking!\n\n` +
            `💇 ${booking.service}\n` +
            `📅 ${booking.date}\n` +
            `⏰ ${booking.time}\n` +
            `📱 ${booking.phone}`
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
        }
      }
    );
  } catch (e) {
    console.log("Owner notify error:", e.message);
  }
}

// ================= SMART TIME =================
function smartTimeDetect(message, slots) {
  const text = message.toLowerCase();

  if (text.includes("morning") || text.includes("subah")) {
    return slots.find(s => parseInt(s) <= 12);
  }

  if (text.includes("evening") || text.includes("shaam")) {
    return slots.find(s => parseInt(s) >= 16);
  }

  if (text.includes("afternoon") || text.includes("dopahar")) {
    return slots.find(s => {
      const h = parseInt(s);
      return h >= 12 && h <= 15;
    });
  }

  return null;
}

// ================= AI BOT =================
function AI(userId, message, businessId) {
  const client = clients[businessId];
  const service = detectService(message);

  if (!memory[userId]) {
    memory[userId] = {
      step: "language",
      lang: null,
      service: null,
      intent: "low",
      upsellOffered: false
    };
  }

  const session = memory[userId];
  const text = normalize(message);

  // INTENT TRACKING
  if (text.includes("price")) session.intent = "medium";
  if (text.includes("book")) session.intent = "high";
  if (/\d{2}:\d{2}/.test(text)) session.intent = "booking";

  // LANGUAGE
  if (session.step === "language") {
    if (text.includes("1") || text.includes("english")) {
      session.lang = "en";
      session.step = "start";

      return `✨ Welcome to ${client.name}\n\n👉 Tell me what you need\n💇 haircut\n🧔 beard\n🧖 facial`;
    }

    if (text.includes("2") || text.includes("hindi")) {
      session.lang = "hi";
      session.step = "start";

      return `✨ ${client.name} में स्वागत है\n\n👉 Batao kya chahiye`;
    }

    if (text.includes("3") || text.includes("hinglish")) {
      session.lang = "hinglish";
      session.step = "start";

      return `✨ Welcome to ${client.name}\n\n👉 Batao kya karwana hai`;
    }

    return "🌐 Choose language:\n1. English\n2. हिंदी\n3. Hinglish";
  }

  // GREETING
  if (/(hi|hello|hey|namaste)/.test(text)) {
    return reply(
      session,
      `✨ Welcome to ${client.name}\n\n💼 Premium Grooming Experience\n\n👉 Tell me what you need`,
      `✨ ${client.name} में स्वागत है\n\n👉 Batao kya chahiye`,
      `✨ Welcome to ${client.name}\n\n👉 Batao kya karwana hai`
    );
  }

  // PRICE
  if (/(price|rate|cost|kitna)/.test(text)) {
    return reply(
      session,
      `💇 Haircut ₹${client.services.haircut}\n🧖 Facial ₹${client.services.facial}\n🧔 Beard ₹${client.services.beard}`,
      `💇 Haircut ₹${client.services.haircut}\n🧖 Facial ₹${client.services.facial}\n🧔 Beard ₹${client.services.beard}`,
      `💇 Haircut ₹${client.services.haircut}\n🧖 Facial ₹${client.services.facial}\n🧔 Beard ₹${client.services.beard}`
    );
  }

  // SERVICE
  if (service && session.step !== "confirm") {
    session.service = service;
    session.step = "confirm";

    return reply(
      session,
      `✨ Nice choice!\n\n💇 ${service} selected\n\n👉 Type *book* to continue`,
      `✨ Badhiya choice!\n\n💇 ${service} select hua\n\n👉 Book likho`,
      `✨ Mast choice!\n\n💇 ${service} select ho gaya\n\n👉 Book likho`
    );
  }

  // UPSELL
  if (
    session.service === "haircut" &&
    !session.upsellOffered
  ) {
    session.upsellOffered = true;

    return reply(
      session,
      `💡 Add Beard trim for just ₹${client.services.beard} extra?\n\n👉 Type YES or continue booking`,
      `💡 Sirf ₹${client.services.beard} mein beard add karna hai?`,
      `💡 Beard add karein sirf ₹${client.services.beard} mein?`
    );
  }

  if (session.upsellOffered && /(yes|haan)/i.test(text)) {
    session.service = session.service + " + beard";

    return reply(
      session,
      `🔥 Combo selected!\n\n💇 ${session.service}\n\n👉 Type *book*`,
      `🔥 Combo select ho gaya!`,
      `🔥 Combo ready!`
    );
  }

  // BOOK FLOW
  const slots = client.availableSlots || ["10:00", "12:00", "14:00", "16:00"];

  if (
    session.service &&
    /(book|booking|confirm|kar|karna)/i.test(text)
  ) {
    session.step = "slot";

    return reply(
      session,
      `✨ Great choice!\n\n📅 Available slots:\n${slots.map(s => `• ${s}`).join("\n")}\n\n👉 Reply with time`,
      `📅 Available slots:\n${slots.map(s => `• ${s}`).join("\n")}`,
      `📅 Available slots:\n${slots.map(s => `• ${s}`).join("\n")}`
    );
  }

  // SLOT DETECTION
  const clean = text.replace(/\s/g, "");

  let slot = slots.find(s => {
    return (
      clean.includes(s) ||
      clean.includes(s.replace(":", "")) ||
      clean.includes(s.replace(":00", ""))
    );
  });

  if (!slot) {
    slot = smartTimeDetect(text, slots);
  }

  if (!slot && session.step === "slot") {
    return reply(
      session,
      `🤖 Best available slot:\n\n⏰ ${slots[0]}\n\n👉 Type YES to confirm`,
      `🤖 Best slot mila:\n\n⏰ ${slots[0]}`,
      `🤖 Best slot mil gaya:\n\n⏰ ${slots[0]}`
    );
  }

  if (session.step === "slot" && /(yes|haan|ok|theek)/i.test(text)) {
    slot = slots[0];
  }

  // BOOKING CONFIRM
  if (session.step === "slot" && slot) {
    const date = detectDate(message);

    bookings.push({
      phone: userId,
      service: session.service,
      time: slot,
      date,
      businessId
    });

    followups.push({
      phone: userId,
      businessId,
      time: Date.now() + 3600000,
      type: "r1",
      sent: false
    });

    session.awaitingPayment = true;

    notifyOwner(client, {
      service: session.service,
      time: slot,
      date,
      phone: userId
    });

    return reply(
      session,
      `✅ Booking Confirmed!\n\n💇 ${session.service}\n📅 ${date}\n⏰ ${slot}\n\n💳 Type *pay*`,
      `✅ Booking confirm ho gaya!`,
      `✅ Booking done!`
    );
  }

  return reply(
    session,
    `🤖 I can help with:\n• haircut\n• beard\n• facial\n• booking`,
    `🤖 Main help kar sakta hoon`,
    `🤖 Main help kar sakta hoon`
  );
}

// ================= FOLLOWUP =================
setInterval(async () => {
  for (let f of followups) {
    if (!f.sent && Date.now() > f.time) {
      const client = clients[f.businessId];

      try {
        await axios.post(
          `https://graph.facebook.com/v18.0/${client.phone_number_id}/messages`,
          {
            messaging_product: "whatsapp",
            to: f.phone,
            text: {
              body:
                f.type === "r1"
                  ? "⏳ Your slot is almost gone! Complete booking now ✅"
                  : "🔥 Slots filling fast!"
            }
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
            }
          }
        );

        f.sent = true;
      } catch (e) {
        console.log("Followup error:", e.message);
      }
    }
  }

  saveAll();
}, 60000);

// ================= DISCOVERY ENGINE =================
function buildWaLink(source, user) {
  const ref = `${source}_${Date.now()}`;
  return `https://wa.me/${process.env.BOT_NUMBER}?text=Hi&ref=${ref}`;
}

async function scanSources() {
  return [
    {
      text: "haircut price near me",
      user: "user1",
      source: "instagram"
    },
    {
      text: "best beard trim nearby",
      user: "user2",
      source: "reddit"
    }
  ];
}

async function respondToLead(item) {
  const link = buildWaLink(item.source, item.user);

  console.log(`🔥 Responding to ${item.user}`);
  console.log(`👉 ${link}`);
}

setInterval(async () => {
  try {
    const items = await scanSources();

    for (const item of items) {
      if (isSmartLead(item.text)) {
        await respondToLead(item);
      }
    }
  } catch (e) {
    console.log("Discovery error:", e.message);
  }
}, 60000);

// ================= WEBHOOK =================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!msg) return;

    const from = msg.from;
    const text = msg.text?.body || "";

    const phoneId =
      req.body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

    const businessId = Object.keys(clients).find(
      key => clients[key].phone_number_id === phoneId
    );

    if (!businessId) return;

    const client = clients[businessId];

    // TRIAL CHECK
    if (!client.isPaid && Date.now() > client.trialEnds) {
      await axios.post(
        `https://graph.facebook.com/v18.0/${phoneId}/messages`,
        {
          messaging_product: "whatsapp",
          to: from,
          text: {
            body:
              "⚠️ This business is temporarily unavailable."
          }
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
          }
        }
      );

      return;
    }

    const replyMsg = AI(from, text, businessId);

    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneId}/messages`,
      {
        messaging_product: "whatsapp",
        to: from,
        text: {
          body: replyMsg
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
        }
      }
    );

    // PAYMENT
    if (text.toLowerCase() === "pay") {
      const service = memory[from]?.service || "haircut";

      let amount = 0;

      if (service.includes("haircut")) {
        amount += client.services.haircut;
      }

      if (service.includes("beard")) {
        amount += client.services.beard;
      }

      if (service.includes("facial")) {
        amount += client.services.facial;
      }

      const qr = await generateQRImage(
        client.upi,
        client.name,
        amount,
        service
      );

      await axios.post(
        `https://graph.facebook.com/v18.0/${phoneId}/messages`,
        {
          messaging_product: "whatsapp",
          to: from,
          type: "image",
          image: {
            link: qr,
            caption:
              `💳 Secure your slot\n\n` +
              `💰 Amount: ₹${amount}\n\n` +
              `👉 After payment type DONE`
          }
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
          }
        }
      );
    }

    // PAYMENT CONFIRM
    if (/paid|done|kar diya/.test(text.toLowerCase())) {
      const service = memory[from]?.service || "haircut";

      let amount = 0;

      if (service.includes("haircut")) {
        amount += client.services.haircut;
      }

      if (service.includes("beard")) {
        amount += client.services.beard;
      }

      if (service.includes("facial")) {
        amount += client.services.facial;
      }

      revenue.push({
        phone: from,
        service,
        amount,
        businessId,
        date: new Date().toISOString()
      });

      await axios.post(
        `https://graph.facebook.com/v18.0/${phoneId}/messages`,
        {
          messaging_product: "whatsapp",
          to: from,
          text: {
            body:
              "✅ Payment confirmed! Your appointment is secured."
          }
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
          }
        }
      );
    }

    saveAll();
  } catch (e) {
    console.log("ERROR:", e.message);
  }
});

// ================= START =================
app.listen(PORT, () => {
  console.log("🔥 ULTRA SERVER RUNNING", PORT);
});
