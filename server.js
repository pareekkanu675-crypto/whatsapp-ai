require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "secret";

// ================= SAFE RAZORPAY =================
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
  console.log("✅ Razorpay Ready");
} else {
  console.log("⚠️ Razorpay not configured");
}

// ================= DATABASE =================
const DB = {
  users: "users.json",
  clients: "clients.json",
  leads: "leads.json",
  bookings: "bookings.json",
  memory: "memory.json",
  revenue: "revenue.json",
  followups: "followups.json"
};

function load(file, fallback) {
  try {
    return fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file))
      : fallback;
  } catch {
    return fallback;
  }
}

let users = load(DB.users, {});
let clients = load(DB.clients, {});
let leads = load(DB.leads, {});
let bookings = load(DB.bookings, []);
let memory = load(DB.memory, {});
let revenue = load(DB.revenue, []);
let followups = load(DB.followups, []);

function saveAll() {
  fs.writeFileSync(DB.users, JSON.stringify(users, null, 2));
  fs.writeFileSync(DB.clients, JSON.stringify(clients, null, 2));
  fs.writeFileSync(DB.leads, JSON.stringify(leads, null, 2));
  fs.writeFileSync(DB.bookings, JSON.stringify(bookings, null, 2));
  fs.writeFileSync(DB.memory, JSON.stringify(memory, null, 2));
  fs.writeFileSync(DB.revenue, JSON.stringify(revenue, null, 2));
  fs.writeFileSync(DB.followups, JSON.stringify(followups, null, 2));
}

// ================= BASIC ROUTES =================
app.get("/", (req, res) => res.send("🚀 AI SaaS Running"));

app.get("/privacy", (req, res) =>
  res.send("Privacy Policy: We store messages for booking automation.")
);

app.get("/terms", (req, res) =>
  res.send("Terms: Usage implies consent to automation.")
);

app.post("/delete", (req, res) =>
  res.send({ success: true, message: "Deletion requested" })
);

// ================= AUTH =================
app.post("/api/register", async (req, res) => {
  const { email, password, businessName, phoneId } = req.body;

  if (users[email]) return res.send({ error: "User exists" });

  const hash = await bcrypt.hash(password, 10);

  users[email] = { password: hash, plan: "free", expiresAt: null };

  clients[email] = {
    name: businessName || "Salon",
    services: { haircut: 300, facial: 800, beard: 200 },
    timings: "10 AM - 8 PM",
    availableSlots: ["10:00", "12:00", "14:00", "16:00"],
    phone_number_id: phoneId || process.env.PHONE_NUMBER_ID
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
    revenue: userRevenue.reduce((s, r) => s + r.amount, 0),
    plan: users[email]?.plan
  });
});

// ================= AI ENGINE =================
function clean(msg) {
  return msg.toLowerCase().replace(/[^a-z0-9 ]/g, "");
}

function detectService(msg, services) {
  return Object.keys(services).find(s => msg.includes(s));
}

function detectSlot(msg, slots) {
  return slots.find(s => msg.includes(s));
}

function AI(userId, message, businessId) {
  const client = clients[businessId];
  const msg = clean(message);

  if (!memory[userId]) {
    memory[userId] = { service: null, waiting: false };
  }

  const session = memory[userId];

  if (!leads[businessId]) leads[businessId] = [];
  if (!leads[businessId].find(l => l.phone === userId)) {
    leads[businessId].push({ phone: userId });
  }

  if (/hi|hello|hey/.test(msg)) {
    return `Hey 👋 Welcome to ${client.name}! Ask for pricing or booking 😊`;
  }

  if (/price|cost|rate|kitna/.test(msg)) {
    return Object.entries(client.services)
      .map(([s, p]) => `${s}: ₹${p}`)
      .join("\n");
  }

  if (/time|open/.test(msg)) {
    return `🕒 ${client.timings}`;
  }

  const service = detectService(msg, client.services);

  if (service) {
    session.service = service;
    session.waiting = true;
    return `${service} selected 👍\nSlots:\n${client.availableSlots.join(" | ")}`;
  }

  const slot = detectSlot(msg, client.availableSlots);

  if (session.waiting && slot) {
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

    session.waiting = false;

    return `✅ Booked at ${slot}`;
  }

  return "Say price, service or booking 😊";
}

// ================= PAYMENT =================
app.post("/api/create-order", async (req, res) => {
  if (!razorpay) return res.send({ error: "Payment disabled" });

  const order = await razorpay.orders.create({
    amount: 49900,
    currency: "INR"
  });

  res.send(order);
});

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
          text: { body: "Hey 😊 Need help with your booking?" }
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

// ================= WEBHOOK =================
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }

  res.sendStatus(403);
});

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

    saveAll();
  } catch (e) {
    console.log("ERROR:", e.message);
  }
});

// ================= START =================
app.listen(PORT, () => console.log("🔥 SERVER RUNNING", PORT));
