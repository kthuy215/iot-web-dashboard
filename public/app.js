const $ = (id) => document.getElementById(id);

const state = {
  deviceId: "",
  pollMs: 2000,
  samples: [],
  lastValues: { led: null, buzzer: null },
  busy: { led: false, buzzer: false }
};

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "--";
  return Number(value).toFixed(digits);
}

function formatTime(timestamp) {
  if (!timestamp) return "Chưa có dữ liệu";
  return new Date(timestamp).toLocaleTimeString("vi-VN", { hour12: false });
}

function setConnection(online, text) {
  const pill = $("connectionPill");
  pill.classList.toggle("online", online);
  pill.classList.toggle("offline", !online);
  $("connectionText").textContent = text;
  $("sideConnection").textContent = text;
  $("sideDot").classList.toggle("online", online);
  $("sideDot").classList.toggle("offline", !online);
}

function updateDevice(target, value) {
  const isKnown = typeof value === "boolean";
  const label = target === "led" ? "LED" : "Buzzer";
  const badge = $(target + "Badge");
  const text = $(target + "StateText");
  const button = $(target + "Toggle");

  state.lastValues[target] = isKnown ? value : null;

  badge.className = "state-badge " + (isKnown ? (value ? "on" : "off") : "unknown");
  badge.textContent = isKnown ? (value ? "ON" : "OFF") : "UNKNOWN";
  text.textContent = isKnown
    ? (value ? `${label} đang bật trên ESP32` : `${label} đang tắt trên ESP32`)
    : "Chưa nhận được Telemetry trạng thái";

  button.textContent = isKnown ? (value ? "TẮT" : "BẬT") : "—";
  button.disabled = !isKnown || state.busy[target];
}

function drawChart() {
  const canvas = $("temperatureChart");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height;
  const left = 38, right = 10, top = 12, bottom = 25;
  const plotW = w - left - right, plotH = h - top - bottom;

  ctx.clearRect(0, 0, w, h);
  const values = state.samples.map(s => s.value);
  if (!values.length) {
    ctx.fillStyle = "#7186a1";
    ctx.font = "11px Be Vietnam Pro, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Đang chờ dữ liệu nhiệt độ từ ThingsBoard...", w / 2, h / 2);
    $("sampleCount").textContent = "0 điểm dữ liệu";
    return;
  }

  let min = Math.min(...values), max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }
  const padding = Math.max((max - min) * .2, .5);
  min -= padding; max += padding;

  ctx.strokeStyle = "rgba(148,163,184,.13)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#7186a1";
  ctx.font = "9px Be Vietnam Pro, sans-serif";
  ctx.textAlign = "right";

  for (let i = 0; i <= 4; i++) {
    const y = top + (plotH * i / 4);
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(w - right, y); ctx.stroke();
    const val = max - ((max - min) * i / 4);
    ctx.fillText(val.toFixed(1), left - 8, y + 3);
  }

  const points = state.samples.map((s, i) => ({
    x: left + (state.samples.length === 1 ? plotW / 2 : i * plotW / (state.samples.length - 1)),
    y: top + (max - s.value) / (max - min) * plotH
  }));

  const gradient = ctx.createLinearGradient(0, top, 0, h - bottom);
  gradient.addColorStop(0, "rgba(96,165,250,.25)");
  gradient.addColorStop(1, "rgba(96,165,250,0)");

  ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  if (points.length > 1) {
    ctx.lineTo(points[points.length - 1].x, h - bottom);
    ctx.lineTo(points[0].x, h - bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.strokeStyle = "#60a5fa";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  const last = points[points.length - 1];
  ctx.beginPath(); ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#93c5fd"; ctx.fill();
  ctx.strokeStyle = "#142238"; ctx.lineWidth = 2; ctx.stroke();

  $("sampleCount").textContent = `${state.samples.length} điểm dữ liệu`;
}

function addTemperatureSample(value, timestamp) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return;
  const ts = timestamp || Date.now();
  const last = state.samples[state.samples.length - 1];
  // Khong them trung mot timestamp khi poll nhanh hon chu ky telemetry.
  if (last && last.ts === ts) return;
  state.samples.push({ ts, value: Number(value) });
  if (state.samples.length > 40) state.samples.shift();
  drawChart();
}

async function loadStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Không đọc được dữ liệu ThingsBoard");

    setConnection(data.online, data.online ? "Đang kết nối" : "Thiết bị chưa gửi dữ liệu mới");
    const v = data.values || {};

    $("temperature").textContent = formatNumber(v.temperature, 2);
    $("pressure").textContent = formatNumber(v.pressure, 2);
    $("altitude").textContent = formatNumber(v.altitude, 2);
    $("lastUpdate").textContent = formatTime(data.lastUpdate);

    updateDevice("led", v.led);
    updateDevice("buzzer", v.buzzer);

    if (v.temperature !== null && v.temperature !== undefined) {
      addTemperatureSample(v.temperature, data.lastUpdate);
    }
  } catch (error) {
    setConnection(false, "Lỗi kết nối");
    $("rpcMessage").textContent = error.message;
    $("rpcMessage").className = "rpc-message error";
  }
}

async function sendRpc(target) {
  const current = state.lastValues[target];
  if (typeof current !== "boolean" || state.busy[target]) return;

  const desired = !current;
  state.busy[target] = true;
  updateDevice(target, current);
  const button = $(target + "Toggle");
  button.disabled = true;
  button.textContent = "ĐỢI...";
  $("rpcMessage").className = "rpc-message";
  $("rpcMessage").textContent = `Đang gửi lệnh ${target.toUpperCase()} ${desired ? "ON" : "OFF"} đến ESP32...`;

  try {
    const response = await fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, state: desired })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.detail || result.error || "Gửi RPC thất bại");
    }

    $("rpcMessage").className = "rpc-message success";
    $("rpcMessage").textContent = `ESP32 đã phản hồi RPC ${result.method}. Đang chờ Telemetry xác nhận trạng thái thực tế...`;

    // Khong tu doi giao dien thanh ON/OFF. Poll lai Telemetry de xac nhan tu ESP32.
    let confirmed = false;
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await loadStatus();
      if (state.lastValues[target] === desired) {
        confirmed = true;
        break;
      }
    }

    if (confirmed) {
      $("rpcMessage").className = "rpc-message success";
      $("rpcMessage").textContent = `Đã xác nhận: ${target.toUpperCase()} ${desired ? "ON" : "OFF"} trên Wokwi và Web.`;
    } else {
      $("rpcMessage").className = "rpc-message error";
      $("rpcMessage").textContent = "Đã gửi RPC nhưng chưa thấy Telemetry xác nhận. Kiểm tra ESP32/Wokwi và key trạng thái.";
    }
  } catch (error) {
    $("rpcMessage").className = "rpc-message error";
    $("rpcMessage").textContent = error.message;
  } finally {
    state.busy[target] = false;
    await loadStatus();
  }
}

async function init() {
  try {
    const response = await fetch("/api/config");
    const config = await response.json();
    state.deviceId = config.deviceId || "";
    state.pollMs = Math.max(1000, Number(config.pollIntervalMs) || 2000);
    $("deviceShort").textContent = state.deviceId
      ? `${state.deviceId.slice(0, 8)}...${state.deviceId.slice(-6)}`
      : "Chưa cấu hình";
  } catch {
    $("deviceShort").textContent = "Không đọc được cấu hình";
  }

  $("ledToggle").addEventListener("click", () => sendRpc("led"));
  $("buzzerToggle").addEventListener("click", () => sendRpc("buzzer"));
  window.addEventListener("resize", drawChart);

  drawChart();
  await loadStatus();
  setInterval(loadStatus, state.pollMs);
  setInterval(() => {
    $("clock").textContent = new Date().toLocaleTimeString("vi-VN", { hour12: false });
  }, 1000);
}

init();