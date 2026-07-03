import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function parseArgs(argv) {
  const args = {
    session: "close",
    mode: "hot",
    port: 4173,
    width: 1080,
    fps: 30,
    extraMs: 2000,
    outputDir: path.join(rootDir, "recordings"),
    headless: false,
  };
  for (const arg of argv) {
    const [key, value = ""] = arg.replace(/^--/, "").split("=");
    if (key === "session") args.session = value;
    if (key === "mode") args.mode = value;
    if (key === "port") args.port = Number(value);
    if (key === "width") args.width = Number(value);
    if (key === "fps") args.fps = Number(value);
    if (key === "extra-ms") args.extraMs = Number(value);
    if (key === "output-dir") args.outputDir = path.resolve(value);
    if (key === "headless") args.headless = value !== "false";
  }
  if (!["morning", "close"].includes(args.session)) {
    throw new Error("--session must be morning or close");
  }
  if (!["hot", "custom"].includes(args.mode)) {
    throw new Error("--mode must be hot or custom");
  }
  if (!Number.isFinite(args.port) || args.port <= 0) {
    throw new Error("--port must be a positive number");
  }
  if (!Number.isFinite(args.width) || args.width < 320) {
    throw new Error("--width must be at least 320");
  }
  args.height = Math.round(args.width * 16 / 9);
  args.fps = Math.min(Math.max(Number(args.fps) || 30, 10), 60);
  args.extraMs = Math.max(Number(args.extraMs) || 2000, 0);
  return args;
}

function toWindowsPath(filePath) {
  return decodeURIComponent(filePath).replace(/^\/([A-Za-z]:\/)/, "$1").replaceAll("/", "\\");
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("未找到 Chrome/Edge。可设置 CHROME_PATH 指向 chrome.exe 或 msedge.exe。");
  }
  return found;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function isServerReady(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

async function startPreviewServer(port) {
  if (await isServerReady(port)) {
    return { process: null, started: false };
  }
  const child = spawn(process.execPath, ["server.js"], {
    cwd: toWindowsPath(rootDir),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await isServerReady(port)) {
      return { process: child, started: true };
    }
    if (child.exitCode !== null) {
      throw new Error(`本地服务启动失败：${output.trim() || `exit ${child.exitCode}`}`);
    }
    await wait(500);
  }
  throw new Error(`本地服务启动超时：${output.trim()}`);
}

async function waitForJson(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw lastError || new Error(`等待 ${url} 超时`);
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => this.handleMessage(event));
    this.ws.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("Chrome DevTools connection closed"));
      }
      this.pending.clear();
    });
  }

  handleMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject, timeout } = this.pending.get(message.id);
      clearTimeout(timeout);
      this.pending.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        resolve(message.result);
      }
      return;
    }
    if (message.method && this.events.has(message.method)) {
      for (const handler of this.events.get(message.method)) {
        handler(message.params || {});
      }
    }
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(payload);
    });
  }

  on(method, handler) {
    if (!this.events.has(method)) this.events.set(method, new Set());
    this.events.get(method).add(handler);
  }

  close() {
    this.ws?.close();
  }
}

async function evaluate(client, expression, timeoutMs = 30000) {
  const result = await client.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    timeoutMs,
  );
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(text);
  }
  return result.result?.value;
}

async function startChrome(chromePath, debugPort, appUrl, headless) {
  const profileDir = path.join(rootDir, "recordings", ".chrome-profile");
  await mkdir(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--autoplay-policy=no-user-gesture-required",
    "--hide-scrollbars",
    "--no-first-run",
    "--window-size=1600,1800",
    appUrl,
  ];
  if (headless) args.unshift("--headless=new");
  const child = spawn(chromePath, args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  await waitForJson(`http://127.0.0.1:${debugPort}/json/version`, 30000).catch((error) => {
    throw new Error(`Chrome 启动失败：${stderr.trim() || error.message}`);
  });
  return child;
}

async function captureRecordingFrames(client, args, prepared) {
  const firstFrame = await evaluate(client, "window.__moneyFlowAutomation.renderFrame(0)", 30000);
  const totalPoints = Number(firstFrame.totalPoints || 1);
  const rect = await evaluate(client, "window.__moneyFlowAutomation.posterRect()", 30000);
  const clip = {
    x: Math.max(0, rect.x),
    y: Math.max(0, rect.y),
    width: rect.width,
    height: rect.height,
    scale: Math.max(1, args.width / Math.max(rect.width, 1)),
  };
  const frames = [];
  async function captureFrame() {
    const result = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip,
    }, 15000);
    if (!result?.data) throw new Error("Chrome 截图没有返回数据");
    frames.push(result.data);
  }

  const totalMs = prepared.durationMs + args.extraMs;
  const frameCount = Math.max(2, Math.ceil((totalMs / 1000) * args.fps));
  const animationFrameCount = Math.max(2, Math.ceil((prepared.durationMs / 1000) * args.fps));
  for (let index = 0; index < frameCount; index += 1) {
    const progress = Math.min(index / (animationFrameCount - 1), 1);
    const activeFrame = progress * Math.max(totalPoints - 1, 0);
    await evaluate(client, `window.__moneyFlowAutomation.renderFrame(${activeFrame})`, 30000);
    await captureFrame();
  }
  return {
    frames,
    playResult: {
      cancelled: false,
      deterministic: true,
      durationMs: prepared.durationMs,
      totalPoints,
    },
    rect,
    totalMs,
    frameMs: totalMs / Math.max(frames.length, 1),
  };
}

async function startFrameServer(frames) {
  const port = await getFreePort();
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    const match = url.pathname.match(/^\/frame\/(\d+)\.png$/);
    if (!match) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const index = Number(match[1]);
    const frame = frames[index];
    if (!frame) {
      res.writeHead(404);
      res.end("Frame not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
    });
    res.end(Buffer.from(frame, "base64"));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function encodingExpression(config) {
  return `(${async function encodeFrames(config) {
    if (!window.MediaRecorder) throw new Error("当前浏览器不支持 MediaRecorder");
    const canvas = document.createElement("canvas");
    canvas.width = config.width;
    canvas.height = config.height;
    const context = canvas.getContext("2d", { alpha: false });
    const supportedMime = [
      "video/mp4;codecs=avc1.42E01E",
      "video/mp4;codecs=h264",
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ].find((mime) => MediaRecorder.isTypeSupported(mime));
    if (!supportedMime) throw new Error("当前浏览器不支持 WebM 录制");
    const stream = canvas.captureStream(0);
    const [videoTrack] = stream.getVideoTracks();
    if (!videoTrack?.requestFrame) throw new Error("当前浏览器不支持 canvas requestFrame 录制");
    const recorder = new MediaRecorder(stream, {
      mimeType: supportedMime,
      videoBitsPerSecond: config.videoBitsPerSecond,
    });
    const chunks = [];
    let stoppedRecording = false;
    let settleTimer = 0;
    const stopped = new Promise((resolve, reject) => {
      function settleSoon() {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => resolve(new Blob(chunks, { type: supportedMime })), 250);
      }
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size) chunks.push(event.data);
        if (stoppedRecording) settleSoon();
      });
      recorder.addEventListener("stop", () => {
        stoppedRecording = true;
        settleSoon();
      }, { once: true });
      recorder.addEventListener("error", (event) => reject(event.error || new Error("MediaRecorder failed")), { once: true });
    });

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function loadFrame(index) {
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch(`${config.frameBaseUrl}/frame/${index}.png`, { cache: "no-store" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return await createImageBitmap(await response.blob());
        } catch (error) {
          lastError = error;
          await sleep(100);
        }
      }
      throw new Error(`帧 ${index} 解码失败：${lastError?.message || "unknown error"}`);
    }

    recorder.start(250);
    for (let index = 0; index < config.frameCount; index += 1) {
      const image = await loadFrame(index);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, config.width, config.height);
      context.drawImage(image, 0, 0, config.width, config.height);
      image.close?.();
      videoTrack.requestFrame();
      await sleep(config.frameMs);
    }
    if (recorder.state === "recording") recorder.requestData();
    recorder.stop();
    const blob = await stopped;
    stream.getTracks().forEach((track) => track.stop());
    if (!blob.size) throw new Error("录制结果为空，未生成有效 WebM 数据");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunkSize = 32768;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return {
      mimeType: supportedMime,
      base64: btoa(binary),
      byteLength: bytes.length,
    };
  }})(${JSON.stringify(config)})`;
}

function recordingExpression(options) {
  return `(${async function recordPosterVideo(config) {
    const poster = document.querySelector(".poster");
    const automation = window.__moneyFlowAutomation;
    if (!poster) throw new Error("没有找到 .poster 录制区域");
    if (!automation) throw new Error("页面自动化接口未就绪");
    if (!window.MediaRecorder) throw new Error("当前浏览器不支持 MediaRecorder");

    const width = config.width;
    const height = config.height;
    const fps = config.fps;
    const frameMs = 1000 / fps;
    const rect = poster.getBoundingClientRect();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    const supportedMime = [
      "video/mp4;codecs=avc1.42E01E",
      "video/mp4;codecs=h264",
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ].find((mime) => MediaRecorder.isTypeSupported(mime));
    if (!supportedMime) throw new Error("当前浏览器不支持 WebM 录制");

    const chunks = [];
    const stream = canvas.captureStream(0);
    const [videoTrack] = stream.getVideoTracks();
    if (!videoTrack?.requestFrame) throw new Error("当前浏览器不支持 canvas requestFrame 录制");
    const recorder = new MediaRecorder(stream, {
      mimeType: supportedMime,
      videoBitsPerSecond: config.videoBitsPerSecond,
    });

    function collectStyles() {
      return Array.from(document.styleSheets)
        .map((sheet) => {
          try {
            return Array.from(sheet.cssRules).map((rule) => rule.cssText).join("\\n");
          } catch {
            return "";
          }
        })
        .join("\\n");
    }

    const styleText = collectStyles();
    const serializer = new XMLSerializer();

    async function drawPosterFrame() {
      const clone = poster.cloneNode(true);
      clone.style.margin = "0";
      clone.style.transform = "none";
      clone.style.width = `${rect.width}px`;
      clone.style.height = `${rect.height}px`;
      const wrapper = document.createElement("div");
      wrapper.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
      const style = document.createElement("style");
      style.textContent = styleText;
      wrapper.append(style, clone);
      const serialized = serializer.serializeToString(wrapper);
      const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}" viewBox="0 0 ${rect.width} ${rect.height}">`,
        `<foreignObject x="0" y="0" width="100%" height="100%">${serialized}</foreignObject>`,
        "</svg>",
      ].join("");
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
      try {
        const image = new Image();
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = reject;
          image.src = url;
        });
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    let stopped = false;
    let drawing = false;
    let lastFrameAt = 0;

    async function drawAndRequestFrame() {
      await drawPosterFrame();
      videoTrack.requestFrame();
    }

    function drawLoop(now) {
      if (stopped) return;
      if (!drawing && now - lastFrameAt >= frameMs) {
        drawing = true;
        lastFrameAt = now;
        drawAndRequestFrame().finally(() => {
          drawing = false;
        });
      }
      requestAnimationFrame(drawLoop);
    }

    await drawAndRequestFrame();
    recorder.start(250);
    requestAnimationFrame(drawLoop);
    const playResult = await automation.play();
    await new Promise((resolve) => setTimeout(resolve, config.extraMs));
    stopped = true;
    await drawAndRequestFrame();
    const blob = await new Promise((resolve, reject) => {
      let stoppedRecording = false;
      let settleTimer = 0;
      function settleSoon() {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => resolve(new Blob(chunks, { type: supportedMime })), 250);
      }
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size) chunks.push(event.data);
        if (stoppedRecording) settleSoon();
      });
      recorder.addEventListener("stop", () => {
        stoppedRecording = true;
        settleSoon();
      }, { once: true });
      recorder.addEventListener("error", (event) => reject(event.error || new Error("MediaRecorder failed")), { once: true });
      if (recorder.state === "recording") recorder.requestData();
      recorder.stop();
    });
    stream.getTracks().forEach((track) => track.stop());
    if (!blob.size) throw new Error("录制结果为空，未生成有效 WebM 数据");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunkSize = 32768;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return {
      mimeType: supportedMime,
      base64: btoa(binary),
      byteLength: bytes.length,
      playResult,
      state: automation.getState(),
    };
  }})(${JSON.stringify(options)})`;
}

function timestampForFile(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appUrl = `http://127.0.0.1:${args.port}/`;
  const chromePath = findChrome();
  const server = await startPreviewServer(args.port);
  const debugPort = await getFreePort();
  let chrome = null;
  let client = null;
  try {
    chrome = await startChrome(chromePath, debugPort, appUrl, args.headless);
    const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`, 30000);
    const target = targets.find((item) => item.type === "page") || targets[0];
    if (!target?.webSocketDebuggerUrl) throw new Error("没有找到可连接的 Chrome 页面");
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await evaluate(client, `new Promise((resolve) => {
      if (document.readyState === "complete") resolve(true);
      else window.addEventListener("load", () => resolve(true), { once: true });
    })`, 30000);
    await evaluate(client, `new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (window.__moneyFlowAutomation) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - startedAt > 30000) {
          clearInterval(timer);
          reject(new Error("页面自动化接口等待超时"));
        }
      }, 100);
    })`, 35000);

    console.log(`Preparing ${args.session} data...`);
    const prepared = await evaluate(
      client,
      `window.__moneyFlowAutomation.prepare(${JSON.stringify({ session: args.session, mode: args.mode })})`,
      180000,
    );
    console.log(`Prepared ${prepared.rowCount} rows for ${prepared.dataDate} ${prepared.session}.`);

    console.log("Capturing poster frames...");
    const captured = await captureRecordingFrames(client, args, prepared);
    console.log(`Captured ${captured.frames.length} frames.`);

    const frameServer = await startFrameServer(captured.frames);
    const encodeConfig = {
      width: args.width,
      height: args.height,
      frameCount: captured.frames.length,
      frameMs: captured.frameMs,
      frameBaseUrl: `http://127.0.0.1:${frameServer.port}`,
      videoBitsPerSecond: Math.max(4000000, Math.round(args.width * args.height * 0.45)),
    };
    console.log("Encoding video...");
    let recorded;
    try {
      recorded = await evaluate(
        client,
        encodingExpression(encodeConfig),
        prepared.durationMs + args.extraMs + 300000,
      );
    } finally {
      await frameServer.close();
    }
    const state = await evaluate(client, "window.__moneyFlowAutomation.getState()", 30000);
    const dataDate = state?.dataDate || prepared.dataDate || timestampForFile().slice(0, 10);
    const sessionLabel = args.session === "morning" ? "morning-1130" : "close-1500";
    const outputDir = path.join(args.outputDir, dataDate);
    await mkdir(outputDir, { recursive: true });
    const ext = recorded.mimeType.includes("mp4") ? "mp4" : "webm";
    const outputFile = path.join(outputDir, `${sessionLabel}-${timestampForFile()}.${ext}`);
    const metaFile = outputFile.replace(new RegExp(`\\.${ext}$`, "i"), ".json");
    await writeFile(outputFile, Buffer.from(recorded.base64, "base64"));
    await writeFile(metaFile, JSON.stringify({
      outputFile,
      session: args.session,
      mode: args.mode,
      dataDate,
      mimeType: recorded.mimeType,
      byteLength: recorded.byteLength,
      prepared,
      state,
      playResult: captured.playResult,
      capturedFrameCount: captured.frames.length,
      capturedFrameMs: captured.frameMs,
      posterRect: captured.rect,
      recordedAt: new Date().toISOString(),
      startedPreviewServer: server.started,
    }, null, 2));
    console.log(`Saved ${outputFile}`);
  } finally {
    client?.close();
    if (chrome && chrome.exitCode === null) chrome.kill();
    if (server.process && server.process.exitCode === null) server.process.kill();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
