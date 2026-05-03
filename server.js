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

// 🔥 Serve QR images
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

// ================= AUTH =================
app.post("/api/register", async (req, res) => {
  const { email, password, businessName, upi } = req.body;

  const hash = await bcrypt.hash(password, 10);

  users[email] = { password: hash };

  clients[email] = {
    name: businessName,
    upi,
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

// 🔥 Analytics
app.get("/api/analytics", auth, (req, res) => {
  const email = req.email;
  const userBookings = bookings.filter(b => b.businessId === email);

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

// 🔥 Broadcast
app.post("/api/broadcast", auth, async (req, res) => {
  const { message } = req.body;
  const email = req.email;
  const client = clients[email];

  for (let u of leads[email] || []) {
    await axios.post(
      `https://graph.facebook.com/v18.0/${client.phone_number_id}/messages`,
      {
        messaging_product: "whatsapp",
        to: u.phone,
        text: { body: message }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
        }
      }
    );
  }

  res.send({ success: true });
});

// ================= SMART ENGINE =================
function normalize(msg) {
  return msg.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

function detectIntent(msg) {
  const t = normalize(msg);
  if (/(hi|hello|hey|namaste)/.test(t)) return "greeting";
  if (/(price|kitna|rate|cost)/.test(t)) return "price";
  if (/(book|booking|karna|slot)/.test(t)) return "booking";
  return "unknown";
}

function detectService(msg) {
  const t = normalize(msg);
  const map = {
    haircut: ["haircut", "cut", "baal"],
    beard: ["beard", "daadhi"],
    facial: ["facial", "face"]
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

  if (text.includes("kal") || text.includes("tomorrow"))
    return tomorrow.toISOString().split("T")[0];

  return today.toISOString().split("T")[0];
}

// ================= QR =================
async function generateQRImage(upi, name, amount, service) {
  const link = `upi://pay?pa=${upi}&pn=${name}&am=${amount}&tn=${service}&cu=INR`;

  const fileName = `qr_${Date.now()}.png`;
  const filePath = path.join(__dirname, "public", fileName);

  await QRCode.toFile(filePath, link);

  return `${process.env.BASE_URL}/qr/${fileName}`;
}

// ================= AI =================
function AI(userId, message, businessId) {
  const client = clients[businessId];
  const intent = detectIntent(message);
  const service = detectService(message);

  if (!memory[userId]) memory[userId] = { step: "start", service: null };

  const session = memory[userId];

  if (!leads[businessId]) leads[businessId] = [];
  if (!leads[businessId].find(l => l.phone === userId)) {
    leads[businessId].push({ phone: userId });
  }

  if (intent === "greeting") return `Hey 👋 Welcome to ${client.name}`;

  if (intent === "price") {
    return Object.entries(client.services)
      .map(([s, p]) => `${s}: ₹${p}`)
      .join("\n");
  }

  if (service) {
    session.service = service;
    session.step = "confirm";
    return `${service} selected 👍`;
  }

  if (session.service && session.step === "confirm") {
    session.step = "slot";
    return `Slots:\n${client.availableSlots.join(" | ")}`;
  }

  const slot = client.availableSlots.find(s =>
    normalize(message).includes(s.replace(":", ""))
  );

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

    return `Booked ✅\nTime: ${slot}\nDate: ${date}\nType pay`;
  }

  return "Try: price, haircut, book";
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
          text: {
            body:
              f.type === "r1"
                ? "Reminder 😊 complete your booking"
                : "Slots filling fast!"
          }
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

    // PAYMENT
    if (text.toLowerCase() === "pay") {
      const service = memory[from]?.service;
      const amount = client.services[service];

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
          image: { link: qr, caption: `Pay ₹${amount}` }
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
          }
        }
      );
    }

    // PAYMENT CONFIRM
    if (/paid|done|kar diya/.test(text)) {
      await axios.post(
        `https://graph.facebook.com/v18.0/${phoneId}/messages`,
        {
          messaging_product: "whatsapp",
          to: from,
          text: { body: "Payment confirmed ✅" }
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
app.listen(PORT, () => console.log("🔥 ULTRA SERVER RUNNING", PORT));
