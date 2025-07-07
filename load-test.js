import http from 'k6/http';
import { sleep, check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

// Custom metrics
const errorRate = new Rate('errors');
const checkoutTrend = new Trend('checkout_duration');

// Test configuration
export const options = {
  // Base load test configuration
  scenarios: {
    // Constant load
    steady_load: {
      executor: 'constant-arrival-rate',
      rate: 5,              // 5 RPS (adjust as needed)
      timeUnit: '1s',       // 5 requests per second
      duration: '5m',       // Run for 5 minutes
      preAllocatedVUs: 10,  // Allocate 10 VUs to start
      maxVUs: 50,           // Maximum VUs to handle spikes
    },
    // Periodic error bursts
    error_bursts: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 5,
      maxVUs: 20,
      stages: [
        // No traffic for first minute
        { duration: '1m', target: 0 },
        // Error burst 1: 10 RPS for 10 seconds
        { duration: '10s', target: 10 },
        // Back to 0 for 1 minute
        { duration: '1m', target: 0 },
        // Error burst 2: 15 RPS for 5 seconds
        { duration: '5s', target: 15 },
        // Back to 0 until end
        { duration: '2m45s', target: 0 },
      ],
    },
  },
  thresholds: {
    'errors': ['rate<0.1'],  // Error rate should be less than 10%
    'http_req_duration': ['p(95)<1000'],  // 95% of requests should be below 1s
  },
};

// Available products in catalog for testing
const products = [
  { id: "1", name: "Windsurf Laptop Pro" },
  { id: "2", name: "Cascade AI Assistant" },
  { id: "3", name: "OpenTelemetry Guide Book" },
  { id: "4", name: "Elastic APM T-Shirt" },
  { id: "5", name: "Observability Platform - 1 Year License" }
];

// Test setup
export function setup() {
  // Verify API gateway is up
  const res = http.get('http://localhost:3000/health');
  if (res.status !== 200) {
    throw new Error(`API gateway is not available: ${res.status}`);
  }
  
  return { baseUrl: 'http://localhost:3000' };
}

// Main test function
export default function(data) {
  const baseUrl = data.baseUrl;
  const scenario = __ITER % 10 === 0 ? 'error_scenario' : 'normal_scenario';
  
  // Determine if this iteration should simulate an error
  const shouldSimulateError = scenario === 'error_scenario';
  
  switch(scenario) {
    case 'normal_scenario':
      normalCheckout(baseUrl);
      break;
    case 'error_scenario':
      errorCheckout(baseUrl);
      break;
  }
  
  // Add random think time between requests
  sleep(randomIntBetween(1, 3));
}

// Normal checkout flow
function normalCheckout(baseUrl) {
  const productIdx = randomIntBetween(0, products.length - 1);
  const product = products[productIdx];
  const quantity = randomIntBetween(1, 3);
  
  // Generate random email
  const randomId = Math.floor(Math.random() * 10000);
  const email = `user${randomId}@example.com`;
  
  // Create checkout payload
  const payload = JSON.stringify({
    productId: product.id,
    quantity: quantity,
    customerEmail: email
  });
  
  // Make checkout request
  const start = new Date();
  const res = http.post(`${baseUrl}/checkout`, payload, {
    headers: { 'Content-Type': 'application/json' }
  });
  const duration = new Date() - start;
  
  // Record metrics
  checkoutTrend.add(duration);
  errorRate.add(res.status !== 201);
  
  // Check response
  check(res, {
    'checkout status is 201': (r) => r.status === 201,
    'response has order id': (r) => r.json('orderId') !== undefined,
  });
}

// Error checkout flow - intentionally generate errors
function errorCheckout(baseUrl) {
  // Different error scenarios
  const errorScenarios = [
    // Invalid product ID
    () => {
      return http.post(`${baseUrl}/checkout`, 
        JSON.stringify({
          productId: "invalid_id",
          quantity: 1,
          customerEmail: "user@example.com"
        }), 
        { headers: { 'Content-Type': 'application/json' } }
      );
    },
    // Missing required fields
    () => {
      return http.post(`${baseUrl}/checkout`, 
        JSON.stringify({
          productId: "1",
          // quantity is missing
          customerEmail: "user@example.com"
        }), 
        { headers: { 'Content-Type': 'application/json' } }
      );
    },
    // Invalid quantity
    () => {
      return http.post(`${baseUrl}/checkout`, 
        JSON.stringify({
          productId: "1",
          quantity: -5,
          customerEmail: "user@example.com"
        }), 
        { headers: { 'Content-Type': 'application/json' } }
      );
    },
    // Force payment decline by using large amount
    () => {
      return http.post(`${baseUrl}/checkout`, 
        JSON.stringify({
          productId: "5",  // Most expensive product
          quantity: 10,    // Large quantity to trigger payment decline
          customerEmail: "user@example.com"
        }), 
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
  ];
  
  // Select a random error scenario
  const scenarioIdx = randomIntBetween(0, errorScenarios.length - 1);
  const start = new Date();
  const res = errorScenarios[scenarioIdx]();
  const duration = new Date() - start;
  
  // Record metrics
  checkoutTrend.add(duration);
  errorRate.add(true);  // Always count as error since we're testing error scenarios
  
  // No specific checks for error scenarios as they're expected to fail
}
