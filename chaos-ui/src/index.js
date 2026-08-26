"use strict";

const path = require("path");
const express = require("express");

const PORT = process.env.PORT || 3000;

const SERVICES = [
  "api-gateway",
  "catalog-svc",
  "order-svc",
  "payment-svc",
  "email-worker",
];

const OPERATIONS = {
  "api-gateway": ["all", "GET /products", "GET /products/:id", "POST /checkout"],
  "catalog-svc": ["all", "GET /products", "GET /products/:id"],
  "order-svc": ["all", "POST /order", "GET /order/:id"],
  "payment-svc": ["all", "Charge"],
  "email-worker": ["all", "consume"],
};

const STATUS_CODES = [429, 500, 503, 504];

const DEFAULT_FAULT = {
  down: false,
  delayMs: 0,
  errorRate: 0,
  statusCode: 500,
  failOperation: "all",
};

function defaultFaults() {
  return Object.fromEntries(
    SERVICES.map((name) => [name, { ...DEFAULT_FAULT }])
  );
}

let faults = defaultFaults();

const SCENARIOS = {
  "payment-brownout": {
    label: "Payment brownout",
    description: "Payment Charge fails 35% of the time with 503 after 400ms",
    faults: {
      "payment-svc": {
        delayMs: 400,
        errorRate: 35,
        statusCode: 503,
        failOperation: "Charge",
      },
    },
  },
  "catalog-down": {
    label: "Catalog down",
    description: "catalog-svc hangs all business requests",
    faults: {
      "catalog-svc": { down: true },
    },
  },
  "catalog-product-lookup": {
    label: "Catalog product lookup errors",
    description: "GET /products/:id always returns 500; list still works",
    faults: {
      "catalog-svc": {
        errorRate: 100,
        statusCode: 500,
        failOperation: "GET /products/:id",
      },
    },
  },
  "order-slow-payment-errors": {
    label: "Order slow + payment errors",
    description: "order-svc +2s latency; payment 50% 500s",
    faults: {
      "order-svc": { delayMs: 2000 },
      "payment-svc": {
        errorRate: 50,
        statusCode: 500,
        failOperation: "Charge",
      },
    },
  },
  "checkout-timeouts": {
    label: "Checkout unresponsive",
    description: "api-gateway POST /checkout hangs",
    faults: {
      "api-gateway": { down: true, failOperation: "POST /checkout" },
    },
  },
};

function applyPatch(current, body) {
  if (typeof body.down === "boolean") {
    current.down = body.down;
  }
  if (body.delayMs !== undefined) {
    const delayMs = Number(body.delayMs);
    if (!Number.isFinite(delayMs)) {
      throw new Error("delayMs must be a number");
    }
    current.delayMs = Math.max(0, Math.min(5000, Math.round(delayMs)));
  }
  if (body.errorRate !== undefined) {
    const errorRate = Number(body.errorRate);
    if (!Number.isFinite(errorRate)) {
      throw new Error("errorRate must be a number");
    }
    current.errorRate = Math.max(0, Math.min(100, Math.round(errorRate)));
  }
  if (body.statusCode !== undefined) {
    const statusCode = Number(body.statusCode);
    if (!STATUS_CODES.includes(statusCode)) {
      throw new Error("statusCode must be 429, 500, 503, or 504");
    }
    current.statusCode = statusCode;
  }
  if (typeof body.failOperation === "string") {
    current.failOperation = body.failOperation;
  }
  return current;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

app.get("/api/meta", (_req, res) => {
  res.json({ services: SERVICES, operations: OPERATIONS, statusCodes: STATUS_CODES, scenarios: SCENARIOS });
});

app.get("/api/faults", (_req, res) => {
  res.json(faults);
});

app.post("/api/faults/reset", (_req, res) => {
  faults = defaultFaults();
  res.json(faults);
});

app.get("/api/faults/:service", (req, res) => {
  const current = faults[req.params.service];
  if (!current) {
    return res.status(404).json({ error: "unknown service" });
  }
  res.json(current);
});

app.put("/api/faults/:service", (req, res) => {
  const current = faults[req.params.service];
  if (!current) {
    return res.status(404).json({ error: "unknown service" });
  }
  try {
    applyPatch(current, req.body || {});
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json(current);
});

app.post("/api/scenarios/:id", (req, res) => {
  const scenario = SCENARIOS[req.params.id];
  if (!scenario) {
    return res.status(404).json({ error: "unknown scenario" });
  }
  faults = defaultFaults();
  for (const [name, patch] of Object.entries(scenario.faults)) {
    if (faults[name]) {
      applyPatch(faults[name], patch);
    }
  }
  res.json(faults);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`chaos-ui listening on ${PORT}`);
});
