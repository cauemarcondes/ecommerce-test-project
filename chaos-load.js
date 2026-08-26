import http from "k6/http";
import { check } from "k6";
import { Rate, Trend } from "k6/metrics";
import { randomIntBetween } from "https://jslib.k6.io/k6-utils/1.2.0/index.js";

// Clean checkout traffic for the chaos UI (http://localhost:3000).
// Do not mix this with load-test.js error bursts — inject faults in the UI only.
//
//   k6 run chaos-load.js
//
// Ctrl+C when you are done. Thresholds are omitted so k6 keeps running while services hang.

const errorRate = new Rate("errors");
const checkoutTrend = new Trend("checkout_duration");

export const options = {
  scenarios: {
    steady_load: {
      executor: "constant-arrival-rate",
      rate: 5,
      timeUnit: "1s",
      duration: "10m",
      preAllocatedVUs: 15,
      maxVUs: 80,
    },
  },
};

const products = [
  { id: "1", name: "Windsurf Laptop Pro" },
  { id: "2", name: "Cascade AI Assistant" },
  { id: "3", name: "OpenTelemetry Guide Book" },
  { id: "4", name: "Elastic APM T-Shirt" },
  { id: "5", name: "Observability Platform - 1 Year License" },
];

export function setup() {
  const res = http.get("http://localhost:4000/health");
  if (res.status !== 200) {
    throw new Error(`API gateway is not available: ${res.status}`);
  }
  return { baseUrl: "http://localhost:4000" };
}

export default function (data) {
  const product = products[randomIntBetween(0, products.length - 1)];
  const payload = JSON.stringify({
    productId: product.id,
    quantity: randomIntBetween(1, 3),
    customerEmail: `user${randomIntBetween(1, 10000)}@example.com`,
  });

  const start = Date.now();
  const res = http.post(`${data.baseUrl}/checkout`, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: "15s",
  });
  checkoutTrend.add(Date.now() - start);
  errorRate.add(res.status !== 201);

  check(res, {
    "checkout status is 201": (r) => r.status === 201,
  });
}
