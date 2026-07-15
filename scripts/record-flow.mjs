import { spawn, spawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
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
    height: 1920,
    fps: 30,
    extraMs: 2000,
    outputDir: path.join(rootDir, "recordings"),
    headless: false,
    method: "ffmpeg",
    videoBitsPerSecond: 0,
    captureTimeoutMs: 60000,
    ffmpegPath: "",
    sourceWidth: 0,
    sourceHeight: 0,
  };
  let heightProvided = false;
  for (const arg of argv) {
    const [key, value = ""] = arg.replace(/^--/, "").split("=");
    if (key === "session") args.session = value;
    if (key === "mode") args.mode = value;
    if (key === "port") args.port = Number(value);
    if (key === "width") args.width = Number(value);
    if (key === "height") {
      args.height = Number(value);
      heightProvided = true;
    }
    if (key === "fps") args.fps = Number(value);
    if (key === "extra-ms") args.extraMs = Number(value);
    if (key === "output-dir") args.outputDir = path.resolve(value);
    if (key === "headless") args.headless = value !== "false";
    if (key === "method") args.method = value;
    if (key === "bitrate") args.videoBitsPerSecond = Number(value);
    if (key === "capture-timeout-ms") args.captureTimeoutMs = Number(value);
    if (key === "ffmpeg-path") args.ffmpegPath = value;
    if (key === "source-width") args.sourceWidth = Number(value);
    if (key === "source-height") args.sourceHeight = Number(value);
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
  if (!heightProvided) args.height = Math.round(args.width * 16 / 9);
  if (!Number.isFinite(args.height) || args.height < 320) {
    throw new Error("--height must be at least 320");
  }
  args.fps = Math.min(Math.max(Number(args.fps) || 30, 10), 60);
  args.extraMs = Math.max(Number(args.extraMs) || 2000, 0);
  if (!["ffmpeg", "display-media", "legacy-frames"].includes(args.method)) {
    throw new Error("--method must be ffmpeg, display-media or legacy-frames");
  }
  if (args.method === "display-media" && args.headless) {
    throw new Error("--method=display-media 需要可见浏览器窗口，不能搭配 --headless");
  }
  args.videoBitsPerSecond = Math.max(
    Number(args.videoBitsPerSecond) || Math.round(args.width * args.height * 5),
    4000000,
  );
  args.captureTimeoutMs = Math.max(Number(args.captureTimeoutMs) || 60000, 5000);
  args.sourceWidth = Math.max(Number(args.sourceWidth) || 0, 0);
  args.sourceHeight = Math.max(Number(args.sourceHeight) || 0, 0);
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

function wingetFfmpegCandidates() {
  const packagesDir = path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Packages");
  if (!existsSync(packagesDir)) return [];
  try {
    return readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("Gyan.FFmpeg"))
      .flatMap((entry) => {
        const packageDir = path.join(packagesDir, entry.name);
        return readdirSync(packageDir, { withFileTypes: true })
          .filter((child) => child.isDirectory() && child.name.startsWith("ffmpeg-"))
          .map((child) => path.join(packageDir, child.name, "bin", "ffmpeg.exe"));
      });
  } catch {
    return [];
  }
}

function findFfmpeg(args) {
  const candidates = [
    args.ffmpegPath,
    process.env.FFMPEG_PATH,
    "ffmpeg",
    path.join(os.homedir(), "AppData", "Local", "Microsoft", "WindowsApps", "ffmpeg.exe"),
    ...wingetFfmpegCandidates(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate !== "ffmpeg" && !existsSync(candidate)) continue;
    const result = spawnSync(candidate, ["-version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error("未找到 ffmpeg。请安装 ffmpeg，或使用 --ffmpeg-path=C:\\\\path\\\\to\\\\ffmpeg.exe 指定。");
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

async function startChrome(chromePath, debugPort, appUrl, options) {
  const profileDir = path.join(rootDir, "recordings", ".chrome-profile");
  await mkdir(profileDir, { recursive: true });
  const chromeArgs = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--autoplay-policy=no-user-gesture-required",
    "--hide-scrollbars",
    "--no-first-run",
    `--window-size=${Math.max(1080, options.width)},${Math.max(1920, options.height)}`,
  ];
  if (options.method === "display-media") {
    chromeArgs.push(
      "--allow-http-screen-capture",
      "--enable-usermedia-screen-capturing",
      "--enable-experimental-web-platform-features",
      "--auto-select-tab-capture-source-by-title=A股板块资金流向",
      "--auto-select-desktop-capture-source=A股板块资金流向",
    );
  }
  if (options.headless) chromeArgs.unshift("--headless=new");
  chromeArgs.push(appUrl);
  const child = spawn(chromePath, chromeArgs, {
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

function recordingViewportExpression(config) {
  return `(${function enterRecordingViewport(config) {
    document.documentElement.style.background = "#ffffff";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    document.body.style.background = "#ffffff";
    document.title = "A股板块资金流向录制";
    let style = document.getElementById("recordingViewportStyle");
    if (!style) {
      style = document.createElement("style");
      style.id = "recordingViewportStyle";
      document.head.appendChild(style);
    }
    style.textContent = `
      html, body {
        width: 100vw !important;
        height: 100vh !important;
        min-height: 100vh !important;
      }
      .stage {
        width: 100vw !important;
        height: 100vh !important;
        min-height: 100vh !important;
        display: flex !important;
        align-items: stretch !important;
        justify-content: stretch !important;
        padding: 0 !important;
        gap: 0 !important;
        overflow: hidden !important;
        grid-template-columns: none !important;
      }
      .poster {
        width: 100vw !important;
        max-width: none !important;
        height: 100vh !important;
        aspect-ratio: auto !important;
        border: 0 !important;
        box-shadow: none !important;
      }
      .control-panel {
        display: none !important;
      }
    `;
    window.dispatchEvent(new Event("resize"));
    return {
      width: config.width,
      height: config.height,
      devicePixelRatio: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    };
  }})(${JSON.stringify(config)})`;
}

function displayMediaRecordingExpression(options) {
  return `(${async function recordPosterDisplayMedia(config) {
    const poster = document.querySelector(".poster");
    const automation = window.__moneyFlowAutomation;
    if (!poster) throw new Error("没有找到 .poster 录制区域");
    if (!automation) throw new Error("页面自动化接口未就绪");
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("当前浏览器不支持 getDisplayMedia 标签页录制");
    }
    if (!window.MediaRecorder) throw new Error("当前浏览器不支持 MediaRecorder");

    const supportedMime = [
      "video/mp4;codecs=avc1.42E01E",
      "video/mp4;codecs=h264",
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ].find((mime) => MediaRecorder.isTypeSupported(mime));
    if (!supportedMime) throw new Error("当前浏览器不支持 MP4/WebM 录制");

    const displayStream = await Promise.race([
      navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: config.fps,
          width: { ideal: config.width },
          height: { ideal: config.height },
          displaySurface: "browser",
        },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        surfaceSwitching: "exclude",
      }),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error("选择当前标签页录制源超时。请确认 Chrome 是否弹出了共享标签页选择框；如果有，需要选中当前标签页并点击共享。"));
        }, config.capturePromptTimeoutMs);
      }),
    ]);

    const [displayTrack] = displayStream.getVideoTracks();
    let croppedToPoster = false;
    if (config.cropToPoster && window.CropTarget && displayTrack?.cropTo) {
      try {
        const target = await CropTarget.fromElement(poster);
        await displayTrack.cropTo(target);
        croppedToPoster = true;
      } catch {
        croppedToPoster = false;
      }
    }

    const sourceVideo = document.createElement("video");
    sourceVideo.muted = true;
    sourceVideo.playsInline = true;
    sourceVideo.srcObject = displayStream;
    await sourceVideo.play();
    if (!sourceVideo.videoWidth || !sourceVideo.videoHeight) {
      await new Promise((resolve) => {
        sourceVideo.addEventListener("loadedmetadata", resolve, { once: true });
      });
    }

    const canvas = document.createElement("canvas");
    canvas.width = config.width;
    canvas.height = config.height;
    const context = canvas.getContext("2d", { alpha: false });
    const outputStream = canvas.captureStream(config.fps);
    const recorder = new MediaRecorder(outputStream, {
      mimeType: supportedMime,
      videoBitsPerSecond: config.videoBitsPerSecond,
    });
    const chunks = [];
    const frameMs = 1000 / config.fps;
    let stopped = false;
    let drawTimer = 0;

    function drawFrame() {
      if (sourceVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(sourceVideo, 0, 0, canvas.width, canvas.height);
      }
      if (!stopped) drawTimer = window.setTimeout(drawFrame, frameMs);
    }

    const stoppedRecording = new Promise((resolve, reject) => {
      let didStop = false;
      let settleTimer = 0;
      function settleSoon() {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => resolve(new Blob(chunks, { type: supportedMime })), 250);
      }
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size) chunks.push(event.data);
        if (didStop) settleSoon();
      });
      recorder.addEventListener("stop", () => {
        didStop = true;
        settleSoon();
      }, { once: true });
      recorder.addEventListener("error", (event) => reject(event.error || new Error("MediaRecorder failed")), { once: true });
    });

    drawFrame();
    recorder.start(250);
    const playResult = await automation.play();
    await new Promise((resolve) => setTimeout(resolve, config.extraMs));
    stopped = true;
    clearTimeout(drawTimer);
    drawFrame();
    if (recorder.state === "recording") recorder.requestData();
    recorder.stop();
    const blob = await stoppedRecording;
    displayStream.getTracks().forEach((track) => track.stop());
    outputStream.getTracks().forEach((track) => track.stop());
    if (!blob.size) throw new Error("录制结果为空，未生成有效视频数据");

    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunkSize = 32768;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return {
      method: "display-media",
      mimeType: supportedMime,
      base64: btoa(binary),
      byteLength: bytes.length,
      width: config.width,
      height: config.height,
      fps: config.fps,
      croppedToPoster,
      sourceWidth: sourceVideo.videoWidth,
      sourceHeight: sourceVideo.videoHeight,
      playResult,
      state: automation.getState(),
    };
  }})(${JSON.stringify(options)})`;
}

async function fitChromeViewportForNativeCapture(client, args) {
  const screenInfo = await evaluate(client, `({
    availWidth: window.screen.availWidth,
    availHeight: window.screen.availHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight
  })`, 30000);
  const maxSourceHeight = Math.max(360, Math.floor((screenInfo.availHeight || args.height) - 80));
  const maxSourceWidth = Math.max(320, Math.floor((screenInfo.availWidth || args.width) - 80));
  let sourceHeight = args.sourceHeight || Math.min(args.height, maxSourceHeight);
  let sourceWidth = args.sourceWidth || Math.round(sourceHeight * 9 / 16);
  if (sourceWidth > maxSourceWidth) {
    sourceWidth = maxSourceWidth;
    sourceHeight = Math.round(sourceWidth * 16 / 9);
  }
  sourceWidth = Math.max(320, sourceWidth - (sourceWidth % 2));
  sourceHeight = Math.max(568, sourceHeight - (sourceHeight % 2));

  async function resizeToInnerSize() {
    const metrics = await evaluate(client, `({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight
    })`, 30000);
    const extraWidth = Math.max(0, Math.round(metrics.outerWidth - metrics.innerWidth));
    const extraHeight = Math.max(0, Math.round(metrics.outerHeight - metrics.innerHeight));
    const windowInfo = await client.send("Browser.getWindowForTarget");
    if (windowInfo?.windowId) {
      await client.send("Browser.setWindowBounds", {
        windowId: windowInfo.windowId,
        bounds: {
          windowState: "normal",
          left: 0,
          top: 0,
          width: sourceWidth + extraWidth,
          height: sourceHeight + extraHeight,
        },
      });
    }
  }

  await resizeToInnerSize();
  await wait(500);
  await resizeToInnerSize();
  await wait(500);
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: sourceWidth,
    height: sourceHeight,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: sourceWidth,
    screenHeight: sourceHeight,
  });
  const viewport = await evaluate(
    client,
    recordingViewportExpression({ width: sourceWidth, height: sourceHeight }),
    30000,
  );
  const captureRect = await evaluate(client, `(() => {
    const borderX = Math.max(0, Math.round((window.outerWidth - window.innerWidth) / 2));
    const topChrome = Math.max(0, Math.round(window.outerHeight - window.innerHeight - borderX));
    return {
      x: Math.round(window.screenX + borderX),
      y: Math.round(window.screenY + topChrome),
      width: Math.round(window.innerWidth),
      height: Math.round(window.innerHeight),
      screenX: window.screenX,
      screenY: window.screenY,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      borderX,
      topChrome,
      devicePixelRatio: window.devicePixelRatio || 1
    };
  })()`, 30000);
  captureRect.width -= captureRect.width % 2;
  captureRect.height -= captureRect.height % 2;
  return { screenInfo, viewport, captureRect, sourceWidth, sourceHeight };
}

function runFfmpegRecording(ffmpegPath, args, outputFile, captureRect, durationMs) {
  const durationSeconds = Math.max(1, (durationMs / 1000).toFixed(3));
  const filter = [
    `crop=${captureRect.width}:${captureRect.height}:${captureRect.borderX}:${captureRect.topChrome}`,
    `scale=${args.width}:${args.height}:flags=lanczos`,
    `fps=${args.fps}`,
    "setsar=1",
  ].join(",");
  const ffmpegArgs = [
    "-hide_banner",
    "-y",
    "-f", "gdigrab",
    "-framerate", String(args.fps),
    "-i", "title=A股板块资金流向录制 - Google Chrome",
    "-t", String(durationSeconds),
    "-vf", filter,
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outputFile,
  ];
  const child = spawn(ffmpegPath, ffmpegArgs, {
    cwd: toWindowsPath(rootDir),
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stderr });
      else reject(new Error(`ffmpeg 录制失败，退出码 ${code}：${stderr.trim()}`));
    });
  });
  return { child, done };
}

function activateWindowForRecording(chromeProcess) {
  const processId = chromeProcess?.pid ? String(chromeProcess.pid) : "";
  const script = `
    Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@
    $script:targetHwnd = [IntPtr]::Zero
    $callback = [Win32+EnumWindowsProc]{
      param([IntPtr]$candidate, [IntPtr]$lParam)
      if (-not [Win32]::IsWindowVisible($candidate)) { return $true }
      $builder = New-Object System.Text.StringBuilder 512
      [void][Win32]::GetWindowText($candidate, $builder, $builder.Capacity)
      $title = $builder.ToString()
      if ($title -like 'A股板块资金流向录制*' -or $title -like 'A股板块资金流向*Google Chrome*') {
        $script:targetHwnd = $candidate
        return $false
      }
      return $true
    }
    [void][Win32]::EnumWindows($callback, [IntPtr]::Zero)
    $hwnd = $script:targetHwnd
    if ($hwnd -eq [IntPtr]::Zero) { exit 2 }
    [Win32]::ShowWindowAsync($hwnd, 9) | Out-Null
    Start-Sleep -Milliseconds 150
    [Win32]::SetWindowPos($hwnd, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040) | Out-Null
    Start-Sleep -Milliseconds 150
    [Win32]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 300
  `;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
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
  const ffmpegPath = args.method === "ffmpeg" ? findFfmpeg(args) : "";
  const server = await startPreviewServer(args.port);
  const debugPort = await getFreePort();
  let chrome = null;
  let client = null;
  try {
    chrome = await startChrome(chromePath, debugPort, appUrl, args);
    const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`, 30000);
    const target = targets.find((item) => item.type === "page") || targets[0];
    if (!target?.webSocketDebuggerUrl) throw new Error("没有找到可连接的 Chrome 页面");
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    if (args.method === "display-media") {
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: args.width,
        height: args.height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: args.width,
        screenHeight: args.height,
      });
      try {
        const windowInfo = await client.send("Browser.getWindowForTarget");
        if (windowInfo?.windowId) {
          await client.send("Browser.setWindowBounds", {
            windowId: windowInfo.windowId,
            bounds: {
              windowState: "normal",
              width: args.width,
              height: args.height,
              left: 0,
              top: 0,
            },
          });
        }
      } catch {
        // Browser bounds are best-effort; device metrics above define the captured page viewport.
      }
    }
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
    let viewport = null;
    let nativeCapture = null;
    if (args.method === "ffmpeg") {
      nativeCapture = await fitChromeViewportForNativeCapture(client, args);
      viewport = nativeCapture.viewport;
      console.log(
        `Native capture region ${nativeCapture.captureRect.width}x${nativeCapture.captureRect.height}`
          + ` at ${nativeCapture.captureRect.x},${nativeCapture.captureRect.y};`
          + ` output ${args.width}x${args.height}.`,
      );
    } else {
      viewport = await evaluate(
        client,
        recordingViewportExpression({ width: args.width, height: args.height }),
        30000,
      );
      console.log(`Recording viewport ${viewport.innerWidth}x${viewport.innerHeight} DPR ${viewport.devicePixelRatio}.`);
    }

    console.log(`Preparing ${args.session} data...`);
    const prepared = await evaluate(
      client,
      `window.__moneyFlowAutomation.prepare(${JSON.stringify({ session: args.session, mode: args.mode })})`,
      180000,
    );
    console.log(`Prepared ${prepared.rowCount} rows for ${prepared.dataDate} ${prepared.session}.`);

    let recorded;
    let state;
    let playResult;
    let legacyFrameMeta = null;
    let outputFile = "";
    let metaFile = "";
    let dataDate = prepared.dataDate || timestampForFile().slice(0, 10);
    const sessionLabel = args.session === "morning" ? "morning-1130" : "close-1500";
    const outputDir = path.join(args.outputDir, dataDate);
    await mkdir(outputDir, { recursive: true });
    if (args.method === "ffmpeg") {
      outputFile = path.join(outputDir, `${sessionLabel}-${timestampForFile()}.mp4`);
      metaFile = outputFile.replace(/\.mp4$/i, ".json");
      const totalMs = prepared.durationMs + args.extraMs + 1000;
      console.log(`Recording native screen region with ffmpeg (${Math.round(totalMs / 1000)}s)...`);
      if (!activateWindowForRecording(chrome)) {
        console.warn("Warning: 未能确认 Chrome 窗口已激活，录屏可能录到遮挡窗口。");
      }
      await wait(700);
      const ffmpeg = runFfmpegRecording(ffmpegPath, args, outputFile, nativeCapture.captureRect, totalMs);
      await wait(800);
      await evaluate(
        client,
        `(() => {
          window.__moneyFlowAutomationLastPlay = null;
          window.__moneyFlowAutomation.play()
            .then((result) => { window.__moneyFlowAutomationLastPlay = result; })
            .catch((error) => { window.__moneyFlowAutomationLastPlay = { error: error.message }; });
          return true;
        })()`,
        30000,
      );
      await wait(prepared.durationMs + args.extraMs + 500);
      await ffmpeg.done;
      state = await evaluate(client, "window.__moneyFlowAutomation.getState()", 30000);
      playResult = await evaluate(client, "window.__moneyFlowAutomationLastPlay", 30000);
      const fileInfo = await stat(outputFile);
      recorded = {
        method: "ffmpeg",
        mimeType: "video/mp4",
        byteLength: fileInfo.size,
      };
    } else if (args.method === "display-media") {
      console.log("Recording current tab with getDisplayMedia + MediaRecorder...");
      console.log("If Chrome asks what to share, choose the current tab and click Share.");
      recorded = await evaluate(
        client,
        displayMediaRecordingExpression({
          width: args.width,
          height: args.height,
          fps: args.fps,
          extraMs: args.extraMs,
          videoBitsPerSecond: args.videoBitsPerSecond,
          capturePromptTimeoutMs: args.captureTimeoutMs,
          cropToPoster: true,
        }),
        args.captureTimeoutMs + prepared.durationMs + args.extraMs + 120000,
      );
      state = recorded.state;
      playResult = recorded.playResult;
    } else {
      console.log("Capturing poster frames with legacy screenshot fallback...");
      const captured = await captureRecordingFrames(client, args, prepared);
      console.log(`Captured ${captured.frames.length} frames.`);

      const frameServer = await startFrameServer(captured.frames);
      const encodeConfig = {
        width: args.width,
        height: args.height,
        frameCount: captured.frames.length,
        frameMs: captured.frameMs,
        frameBaseUrl: `http://127.0.0.1:${frameServer.port}`,
        videoBitsPerSecond: args.videoBitsPerSecond,
      };
      console.log("Encoding video...");
      try {
        recorded = await evaluate(
          client,
          encodingExpression(encodeConfig),
          prepared.durationMs + args.extraMs + 300000,
        );
      } finally {
        await frameServer.close();
      }
      state = await evaluate(client, "window.__moneyFlowAutomation.getState()", 30000);
      playResult = captured.playResult;
      legacyFrameMeta = {
        capturedFrameCount: captured.frames.length,
        capturedFrameMs: captured.frameMs,
        posterRect: captured.rect,
      };
    }
    dataDate = state?.dataDate || dataDate;
    if (!outputFile) {
      const datedOutputDir = path.join(args.outputDir, dataDate);
      await mkdir(datedOutputDir, { recursive: true });
      const ext = recorded.mimeType.includes("mp4") ? "mp4" : "webm";
      outputFile = path.join(datedOutputDir, `${sessionLabel}-${timestampForFile()}.${ext}`);
      metaFile = outputFile.replace(new RegExp(`\\.${ext}$`, "i"), ".json");
      await writeFile(outputFile, Buffer.from(recorded.base64, "base64"));
    }
    await writeFile(metaFile, JSON.stringify({
      outputFile,
      session: args.session,
      mode: args.mode,
      dataDate,
      mimeType: recorded.mimeType,
      byteLength: recorded.byteLength,
      width: args.width,
      height: args.height,
      fps: args.fps,
      method: args.method,
      videoBitsPerSecond: args.videoBitsPerSecond,
      prepared,
      state,
      playResult,
      displayCapture: args.method === "display-media"
        ? {
            croppedToPoster: recorded.croppedToPoster,
            sourceWidth: recorded.sourceWidth,
            sourceHeight: recorded.sourceHeight,
            viewport,
          }
        : null,
      nativeCapture: args.method === "ffmpeg"
        ? {
            ffmpegPath,
            screenInfo: nativeCapture.screenInfo,
            viewport,
            captureRect: nativeCapture.captureRect,
            sourceWidth: nativeCapture.sourceWidth,
            sourceHeight: nativeCapture.sourceHeight,
          }
        : null,
      legacyFrameMeta,
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
