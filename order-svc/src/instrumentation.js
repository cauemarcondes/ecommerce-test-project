// Elastic APM instrumentation for API Gateway
'use strict';

// Import Elastic APM agent
const apm = require('elastic-apm-node');

// Start the Elastic APM agent
const agent = apm.start({
  serviceName: process.env.ELASTIC_APM_SERVICE_NAME || 'order-svc',
  serviceVersion: process.env.ELASTIC_APM_SERVICE_VERSION || '0.1.0',
  // APM Server URL
  serverUrl: process.env.ELASTIC_APM_SERVER_URL || 'http://localhost:8200',
  // Environment
  environment: process.env.NODE_ENV || 'development',
  // Set log level based on environment
  logLevel: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  // Enable central configuration
  centralConfig: true,
  // Capture request bodies for errors
  captureBody: 'errors',
  // Paths to ignore
  ignoreUrls: ['/health', '/favicon.ico'],
  // Always capture error stack traces
  captureErrorLogStackTraces: 'always',
  // Capture span stack traces for performance debugging
  captureSpanStackTraces: true,
});

console.log(`Elastic APM agent initialized for order-svc`);

// Gracefully shut down on process termination
process.on('SIGTERM', () => {
  if (agent) {
    agent.flush();
  }
  process.exit(0);
});

// Helper functions for working with APM
function createSpan(name, type = 'custom') {
  return apm.startSpan(name, type);
}

// Export the APM agent and utility functions
module.exports = {
  apm,
  createSpan,
  // Convenience function to access the current transaction or span
  getCurrentTransaction: () => apm.currentTransaction,
  getCurrentSpan: () => apm.currentSpan,
  // For distributed tracing
  addLabels: (labels) => {
    const current = apm.currentTransaction || apm.currentSpan;
    if (current && labels) {
      current.addLabels(labels);
    }
  },
  // Capture errors
  captureError: (error, options) => {
    apm.captureError(error, options);
  }
};
