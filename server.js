require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cors = require("cors");
const QRCode = require("qrcode");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "secret";

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

// ================= BASIC ROUTES =================
app.get("/", (req, res) => res.send("🚀 SaaS Running"));
app.get("/privacy", (req, res) => res.send("Privacy Policy"));
app.get("/terms", (req, res) => res.send("Terms"));
app.post("/delete", (req, res) => res.send({ success: true }));

// ================= AUTH =================
app.post("/api/register", async (req, res) => {
  const { email, password, businessName, upi } = req.body;

  if (users[email]) return res.send({ error: "User exists" });

  const hash = await bcrypt.hash(password, 10);

  users[email] = { password: hash, plan: "free" };

  clients[email] = {
    name: businessName,
    upi: upi,
    services: { haircut: 300, facial: 800, beard: 200 },
    timings: "10 AM - 8 PM",
    availableSlots: ["10:00", "12:00", "14:00", "16:00"],
    phone_number_id: process.env.PHONE_NUMBER_ID
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
  res.send({ success: true, token });
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

  const userBookings = bookings.filter(b => b.businessId === email);
  const userRevenue = revenue.filter(r => r.businessId === email);

  res.send({
    leads: (leads[email] || []).length,
    bookings: userBookings.length,
    revenue: userRevenue.reduce((s, r) => s + r.amount, 0)
  });
});

// 🔥 NEW ADMIN API (ADDED)
app.get("/api/all-bookings", (req, res) => {
  res.send(bookings);
});

// ================= SMART ENGINE =================
function normalize(msg) {
  return msg.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

function detectIntent(msg) {
  const text = normalize(msg);

  if (/hi|hello|hey|namaste|bhai/.test(text)) return "greeting";
  if (/price|pricing|cost|kitna|daam|rate|charges/.test(text)) return "price";
  if (/book|booking|appointment|karna|slot/.test(text)) return "booking";
  if (/time|timing|kab|open|close/.test(text)) return "time";

  return "unknown";
}

function detectService(msg) {
  const text = normalize(msg);

  const map = {
    haircut: ["haircut", "cut", "baal", "hair"],
    beard: ["beard", "daadhi", "shave"],
    facial: ["facial", "face", "skin"]
  };

  for (let s in map) {
    if (map[s].some(w => text.includes(w))) return s;
  }

  return null;
}

// 🔥 BETTER SLOT DETECTION (NEW)
function detectSlot(msg, slots) {
  return slots.find(s => msg.includes(s));
}

// ================= BOT =================
function AI(userId, message, businessId) {
  const client = clients[businessId];
  const intent = detectIntent(message);
  const service = detectService(message);

  if (!memory[userId]) {
    memory[userId] = { step: "start", service: null };
  }

  const session = memory[userId];

  // Lead tracking
  if (!leads[businessId]) leads[businessId] = [];
  if (!leads[businessId].find(l => l.phone === userId)) {
    leads[businessId].push({ phone: userId });
  }

  if (intent === "greeting") {
    return `Hey 👋 Welcome to ${client.name}!

Ask for price or booking 😊`;
  }

  if (intent === "price") {
    return Object.entries(client.services)
      .map(([s, p]) => `${s}: ₹${p}`)
      .join("\n");
  }

  if (service) {
    session.service = service;
    return `${service} selected 👍\nReply "book"`;
  }

  if (intent === "booking") {
    if (!session.service) return "Choose service first";

    session.step = "slot";
    return `Slots:\n${client.availableSlots.join(" | ")}`;
  }

  const slot = detectSlot(message, client.availableSlots);

  if (session.step === "slot" && slot) {
    bookings.push({
      phone: userId,
      service: session.service,
      time: slot,
      businessId
    });

    revenue.push({
      businessId,
      amount: client.services[session.service]
    });

    followups.push({
      phone: userId,
      businessId,
      time: Date.now() + 3600000,
      sent: false
    });

    session.step = "done";

    return `Booked ✅ at ${slot}

Type "pay"`;
  }

  return "Say price or book 😊";
}

// ================= UPI QR =================
async function generateQR(upi, name, amount) {
  if (!upi) return null;
  const link = `upi://pay?pa=${upi}&pn=${name}&am=${amount}&cu=INR`;
  return await QRCode.toDataURL(link);
}

// ================= FOLLOWUP =================
setInterval(async () => {
  for (let f of followups) {
    if (!f.sent && Date.now() > f.time) {
      const client = clients[f.businessId];

      await axios.post(
        `https://graph.facebook.com/v18.0/${client.phone_number_id}/messages`,
        {
          messaging_product: "whatsapp",
          to: f.phone,
          text: { body: "Hey 😊 Need help completing your booking?" }
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
          }
        }
      );

      f.sent = true;
    }
  }
}, 60000);

// ================= WEBHOOK VERIFY =================
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }

  res.sendStatus(403);
});

// ================= WEBHOOK =================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const text = msg.text?.body || "";
    const phoneId = req.body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

    const businessId = Object.keys(clients).find(
      key => clients[key].phone_number_id === phoneId
    );

    if (!businessId) return;

    const reply = AI(from, text, businessId);
    const client = clients[businessId];

    // SEND TEXT
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneId}/messages`,
      {
        messaging_product: "whatsapp",
        to: from,
        text: { body: reply }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
        }
      }
    );

    // 🔥 PAYMENT QR
    if (text.toLowerCase() === "pay") {
      const service = memory[from]?.service;
      if (!service) return;

      const amount = client.services[service];
      const qr = await generateQR(client.upi, client.name, amount);

      if (!qr) return;

      await axios.post(
        `https://graph.facebook.com/v18.0/${phoneId}/messages`,
        {
          messaging_product: "whatsapp",
          to: from,
          type: "image",
          image: { link: qr, caption: `Pay ₹${amount}` }
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
          }
        }
      );
    }

    // 🔥 PAYMENT PROOF (NEW)
    if (msg.type === "image") {
      bookings.push({
        phone: from,
        service: memory[from]?.service,
        status: "payment_pending",
        businessId
      });

      await axios.post(
        `https://graph.facebook.com/v18.0/${phoneId}/messages`,
        {
          messaging_product: "whatsapp",
          to: from,
          text: { body: "Payment screenshot received ✅" }
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
  console.log("🔥 SERVER RUNNING", PORT);
});
