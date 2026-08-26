"use strict";

const http = require("http");
const https = require("https");

const HTTP_STATUS_CODES = [429, 500, 503, 504];

const DEFAULTS = {
  down: false,
  delayMs: 0,
  errorRate: 0,
  statusCode: 500,
  failOperation: "all",
};

let down = DEFAULTS.down;
let delayMs = DEFAULTS.delayMs;
let errorRate = DEFAULTS.errorRate;
let statusCode = DEFAULTS.statusCode;
let failOperation = DEFAULTS.failOperation;
let hangWaiters = [];

class ChaosFaultError extends Error {
  constructor(code) {
    super(`Injected chaos fault (${code})`);
    this.name = "ChaosFaultError";
    this.statusCode = code;
    this.chaos = true;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitWhileDown() {
  if (!down) return Promise.resolve();
  return new Promise((resolve) => {
    hangWaiters.push(resolve);
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setFaults(next) {
  const wasDown = down;
  if (typeof next.down === "boolean") {
    down = next.down;
  }
  if (typeof next.delayMs === "number" && Number.isFinite(next.delayMs)) {
    delayMs = clamp(Math.round(next.delayMs), 0, 5000);
  }
  if (typeof next.errorRate === "number" && Number.isFinite(next.errorRate)) {
    errorRate = clamp(Math.round(next.errorRate), 0, 100);
  }
  if (next.statusCode !== undefined) {
    const code = Number(next.statusCode);
    statusCode = HTTP_STATUS_CODES.includes(code) ? code : 500;
  }
  if (typeof next.failOperation === "string" && next.failOperation.length > 0) {
    failOperation = next.failOperation;
  }
  if (wasDown && !down) {
    const waiters = hangWaiters;
    hangWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}

function matchesTarget(ctx = {}) {
  if (!failOperation || failOperation === "all") {
    return true;
  }
  if (ctx.operation && failOperation === ctx.operation) {
    return true;
  }
  const space = failOperation.indexOf(" ");
  if (space === -1) {
    return false;
  }
  const method = failOperation.slice(0, space);
  const opPath = failOperation.slice(space + 1);
  if (ctx.method && method !== ctx.method) {
    return false;
  }
  const escaped = opPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped.replace(/:[^/]+/g, "[^/]+")}$`);
  return re.test(ctx.path || "");
}

async function applyFaults(ctx = {}) {
  if (!matchesTarget(ctx)) {
    return;
  }
  if (delayMs > 0) {
    await sleep(delayMs);
  }
  await waitWhileDown();
  if (errorRate > 0 && Math.random() * 100 < errorRate) {
    throw new ChaosFaultError(statusCode);
  }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: 2000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function startFaultPoller({ serviceName, url }) {
  if (!url || !serviceName) {
    return;
  }
  const endpoint = `${url.replace(/\/$/, "")}/api/faults/${encodeURIComponent(serviceName)}`;
  const poll = async () => {
    try {
      const body = await fetchJson(endpoint);
      if (body && typeof body === "object") {
        setFaults(body);
      }
    } catch {
      setFaults({ ...DEFAULTS });
    }
  };
  poll();
  setInterval(poll, 1000);
}

function expressMiddleware() {
  return async (req, res, next) => {
    const path = (req.path || req.url || "").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      return next();
    }
    try {
      await applyFaults({ method: req.method, path });
      next();
    } catch (err) {
      if (err && err.chaos) {
        return res.status(err.statusCode).json({
          error: "chaos fault",
          statusCode: err.statusCode,
        });
      }
      next(err);
    }
  };
}

module.exports = {
  DEFAULTS,
  ChaosFaultError,
  startFaultPoller,
  applyFaults,
  expressMiddleware,
};
