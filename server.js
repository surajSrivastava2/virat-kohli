const express = require("express");
const cors = require("cors");
const fs = require("fs");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

// ================= GROQ/OPENAI SETUP =================
// Uses Groq API (OpenAI-compatible)
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

async function askAI(messages) {
  const response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "llama3-70b-8192",
      messages: [
        { role: "system", content: "You are SmartStudy AI, a helpful academic tutor for students. Provide clear, concise, and accurate educational assistance." },
        ...messages
      ],
      temperature: 0.7,
      max_tokens: 2048
    })
  });
  
  if (!response.ok) {
    throw new Error(`AI API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.choices[0].message.content;
}

// ================= MIDDLEWARE =================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.static("."));

// ================= JWT =================
const SECRET = process.env.JWT_SECRET || "smartstudy_secret_key";

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const token = auth.slice(7);
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}

// ================= DATA FILES =================
const USERS_FILE = "users.json";
const PLANNER_FILE = "planner.json";
const ATTENDANCE_FILE = "attendance.json";

function loadJson(file, defaultVal = []) {
  if (!fs.existsSync(file)) return defaultVal;
  return JSON.parse(fs.readFileSync(file));
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ================= AUTH =================
app.post("/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ message: "All fields required" });
  }
  
  const users = loadJson(USERS_FILE);
  if (users.find(u => u.email === email)) {
    return res.status(400).json({ message: "User already exists" });
  }
  
  users.push({ name, email, password });
  saveJson(USERS_FILE, users);
  
  const token = jwt.sign({ email, name }, SECRET);
  res.json({ token, user: { name, email } });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: "Email and password required" });
  }
  
  const users = loadJson(USERS_FILE);
  const user = users.find(u => u.email === email && u.password === password);
  if (!user) {
    return res.status(401).json({ message: "Invalid credentials" });
  }
  
  const token = jwt.sign({ email: user.email, name: user.name }, SECRET);
  res.json({ token, user: { name: user.name, email: user.email } });
});

app.get("/me", authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ================= CHAT =================
app.post("/chat", authMiddleware, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ message: "Message required" });
    
    const reply = await askAI([{ role: "user", content: message }]);
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ================= SUMMARIZER =================
app.post("/summarize", authMiddleware, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ message: "Text required" });
    
    const prompt = `Summarize the following study material into clear, concise bullet points suitable for exam revision:\n\n${text}`;
    const summary = await askAI([{ role: "user", content: prompt }]);
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ================= QUIZ =================
app.post("/quiz", authMiddleware, async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic) return res.status(400).json({ message: "Topic required" });
    
    const prompt = `Generate 5 multiple choice questions about "${topic}" for student practice. For each question, provide the question text, 4 options (A, B, C, D), and the correct answer. Format clearly.`;
    const response = await askAI([{ role: "user", content: prompt }]);
    
    // Parse questions from response (split by numbers or newlines)
    const questions = response
      .split(/\n\d+\.|\n(?=\d+\.)|\n(?=Question \d)/i)
      .map(q => q.trim())
      .filter(q => q.length > 20);
    
    res.json({ quiz: questions.length > 0 ? questions : [response] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ================= PLANNER =================
app.post("/planner", authMiddleware, (req, res) => {
  const { plan } = req.body;
  if (!plan) return res.status(400).json({ message: "Plan required" });
  
  const plans = loadJson(PLANNER_FILE, {});
  plans[req.user.email] = plan;
  saveJson(PLANNER_FILE, plans);
  res.json({ success: true });
});

app.get("/planner", authMiddleware, (req, res) => {
  const plans = loadJson(PLANNER_FILE, {});
  res.json({ plan: plans[req.user.email] || null });
});

// ================= ATTENDANCE =================
app.post("/attendance", authMiddleware, (req, res) => {
  const { subject, attended, total } = req.body;
  if (!subject || attended === undefined || !total) {
    return res.status(400).json({ message: "Subject, attended, and total required" });
  }
  
  const records = loadJson(ATTENDANCE_FILE, {});
  if (!records[req.user.email]) records[req.user.email] = [];
  
  // Update if exists, else add
  const existing = records[req.user.email].find(r => r.subject === subject);
  if (existing) {
    existing.attended = attended;
    existing.total = total;
  } else {
    records[req.user.email].push({ subject, attended, total });
  }
  
  saveJson(ATTENDANCE_FILE, records);
  res.json({ success: true });
});

app.get("/attendance", authMiddleware, (req, res) => {
  const records = loadJson(ATTENDANCE_FILE, {});
  res.json({ data: records[req.user.email] || [] });
});

// ================= HEALTH =================
app.get("/health", (req, res) => {
  res.json({ status: "OK", ai: "Groq LLaMA 3-70B" });
});

// ================= START =================
app.listen(PORT, () => {
  console.log(`🚀 SmartStudy backend running on http://localhost:${PORT}`);
});
