require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const TB_URL = (process.env.TB_URL || "https://thingsboard.cloud").replace(/\/+$/, "");
const DEVICE_ID = process.env.TB_DEVICE_ID || "";
const PORT = Number(process.env.PORT || 3000);
const ONLINE_TIMEOUT_MS = Number(process.env.ONLINE_TIMEOUT_MS || 15000);

let cachedJwt = null;
let jwtExpiresAt = 0;

function requiredConfig() {
  if (!DEVICE_ID) throw new Error("Chua cau hinh TB_DEVICE_ID trong file .env");
  if (!process.env.TB_API_KEY &&
      !(process.env.TB_USERNAME && process.env.TB_PASSWORD)) {
    throw new Error("Can TB_API_KEY hoac ca TB_USERNAME va TB_PASSWORD trong file .env");
  }
}

async function loginThingsBoard() {
  const response = await fetch(`${TB_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.TB_USERNAME,
      password: process.env.TB_PASSWORD
    })
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`ThingsBoard dang nhap that bai (${response.status}): ${bodyText.slice(0, 250)}`);
  }

  const data = JSON.parse(bodyText);
  if (!data.token) throw new Error("ThingsBoard khong tra ve JWT token");
  cachedJwt = data.token;
  // Lam moi som hon thoi diem het han; neu khong doc duoc exp thi cache 5 phut.
  try {
    const payload = JSON.parse(Buffer.from(data.token.split(".")[1], "base64").toString("utf8"));
    jwtExpiresAt = (payload.exp ? payload.exp * 1000 : Date.now() + 300000) - 60000;
  } catch {
    jwtExpiresAt = Date.now() + 300000;
  }
  return cachedJwt;
}

async function getAuthHeader(forceRefresh = false) {
  requiredConfig();

  if (process.env.TB_API_KEY) {
    return { "X-Authorization": `ApiKey ${process.env.TB_API_KEY}` };
  }

  if (forceRefresh || !cachedJwt || Date.now() >= jwtExpiresAt) {
    await loginThingsBoard();
  }
  return { "X-Authorization": `Bearer ${cachedJwt}` };
}

async function tbFetch(url, options = {}, retry = true) {
  let auth = await getAuthHeader();
  let response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...auth
    }
  });

  if (response.status === 401 && retry && !process.env.TB_API_KEY) {
    auth = await getAuthHeader(true);
    response = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        ...auth
      }
    });
  }
  return response;
}

function latestValue(data, key) {
  const item = data && data[key] && data[key][0];
  if (!item) return { value: null, ts: null };
  const raw = item.value;
  let value = raw;
  if (raw !== null && raw !== undefined && raw !== "") {
    const numberValue = Number(raw);
    if (Number.isFinite(numberValue)) value = numberValue;
  }
  return { value, ts: Number(item.ts) || null };
}

function asBoolean(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value === null || value === undefined) return false;
  const normalized = String(value).trim().toLowerCase();
  return ["true", "1", "on", "yes"].includes(normalized);
}

app.get("/api/config", (req, res) => {
  res.json({
    deviceId: DEVICE_ID,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 2000)
  });
});

app.get("/api/status", async (req, res) => {
  try {
    const keys = "temperature,pressure,altitude,led,buzzer";
    const url = `${TB_URL}/api/plugins/telemetry/DEVICE/${DEVICE_ID}/values/timeseries?keys=${keys}`;
    const response = await tbFetch(url);

    if (!response.ok) {
      const message = await response.text();
      return res.status(response.status).json({
        error: `Khong doc duoc Telemetry tu ThingsBoard (${response.status})`,
        detail: message.slice(0, 300)
      });
    }

    const data = await response.json();
    const temperature = latestValue(data, "temperature");
    const pressure = latestValue(data, "pressure");
    const altitude = latestValue(data, "altitude");
    const led = latestValue(data, "led");
    const buzzer = latestValue(data, "buzzer");

    const timestamps = [
      temperature.ts, pressure.ts, altitude.ts, led.ts, buzzer.ts
    ].filter(Boolean);
    const lastUpdate = timestamps.length ? Math.max(...timestamps) : null;
    const ageMs = lastUpdate ? Math.max(0, Date.now() - lastUpdate) : null;

    res.json({
      deviceId: DEVICE_ID,
      online: ageMs !== null && ageMs <= ONLINE_TIMEOUT_MS,
      lastUpdate,
      ageMs,
      values: {
        temperature: temperature.value,
        pressure: pressure.value,
        altitude: altitude.value,
        led: data.led ? asBoolean(led.value) : null,
        buzzer: data.buzzer ? asBoolean(buzzer.value) : null
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Loi may chu" });
  }
});

app.post("/api/rpc", async (req, res) => {
  try {
    const { target, state } = req.body || {};
    if (!["led", "buzzer"].includes(target)) {
      return res.status(400).json({ error: "target phai la led hoac buzzer" });
    }
    if (typeof state !== "boolean") {
      return res.status(400).json({ error: "state phai la true hoac false" });
    }

    const method = target === "led" ? "setLed" : "setBuzzer";
    const url = `${TB_URL}/api/rpc/twoway/${DEVICE_ID}`;
    const response = await tbFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method,
        params: state,
        timeout: 10000
      })
    });

    const text = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({
        error: `Gui RPC that bai (${response.status})`,
        detail: text.slice(0, 300)
      });
    }

    let result = null;
    if (text) {
      try { result = JSON.parse(text); }
      catch { result = text; }
    }

    res.json({
      ok: true,
      method,
      requestedState: state,
      deviceResponse: result,
      message: "ThingsBoard da nhan phan hoi RPC tu thiet bi"
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Loi gui RPC" });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "iot-web-dashboard" });
});

app.listen(PORT, () => {
  console.log(`Web Dashboard dang chay tai http://localhost:${PORT}`);
  console.log(`ThingsBoard: ${TB_URL}`);
  console.log(`Device ID: ${DEVICE_ID || "(chua cau hinh)"}`);
});