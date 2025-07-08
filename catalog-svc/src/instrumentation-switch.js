'use strict';

/**
 * This module loads the appropriate instrumentation based on the APM_PROVIDER environment variable.
 * 
 * Set APM_PROVIDER to one of:
 * - 'otel' (default): Uses OpenTelemetry
 * - 'elastic': Uses Elastic APM Node.js agent
 */

// Determine which instrumentation to use
const apmProvider = process.env.APM_PROVIDER || 'otel';

/**
 * Loads the appropriate instrumentation based on the APM_PROVIDER environment variable.
 * @param {string} serviceName - The name of the service (e.g., 'api-gateway', 'order-svc')
 */
function loadInstrumentation(serviceName) {
  if (apmProvider === 'elastic') {
    console.log(`Initializing Elastic APM agent for ${serviceName}`);
    return require('./elastic-instrumentation');
  } else {
    console.log(`Initializing OpenTelemetry for ${serviceName}`);
    return require('./instrumentation');
  }
}

module.exports = {
  apmProvider,
  loadInstrumentation
};
