'use strict';

/**
 * Elastic APM Node.js agent instrumentation for the API Gateway
 */

// Import Elastic APM agent
const apm = require('elastic-apm-node');

// Environment variables
const serviceName = process.env.OTEL_SERVICE_NAME || 'api-gateway';
const serviceVersion = process.env.SERVICE_VERSION || '0.1.0';

// Start the Elastic APM agent
const agent = apm.start({
  serviceName: serviceName,
  serviceVersion: serviceVersion,
  // APM Server URL - default to localhost:8200
  serverUrl: process.env.ELASTIC_APM_SERVER_URL || 'http://localhost:8200',
  // Environment (development, staging, production, etc.)
  environment: process.env.NODE_ENV || 'development',
  // Set to true for development to see more verbose output
  logLevel: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  // Centralized configuration, if used
  centralConfig: true,
  // Capture request bodies for errors
  captureErrorLogStackTraces: 'always',
  // Distributed tracing
  distributedTracingOrigins: ['*'],
  // Other APM options...
  captureBody: 'errors',
  ignoreUrls: ['/health', '/favicon.ico'],
  captureSpanStackTraces: true,
});

console.log(`Elastic APM agent initialized for ${serviceName} (${serviceVersion})`);

// Export the APM agent and similar API to OTel for compatibility in service code
module.exports = {
  apm: agent,
  // Compatibility layer with OTel API
  trace: {
    getTracer: () => ({
      startActiveSpan: (name, options, callback) => {
        if (typeof options === 'function') {
          callback = options;
        }
        const span = apm.startTransaction(name, 'custom');

        span.recordException = (error) => {
          apm.captureError(error, { handled: true });
          // Set error flag on the span
          span.setOutcome('failure');
        };

        span.setStatus = ({ code, message }) => {
          // Map OTel status codes to Elastic APM outcome
          // code 1 = OK, code 2 = ERROR in OTel
          if (code === 2 || (message && message.length > 0)) {
            span.setOutcome('failure');
          } else {
            span.setOutcome('success');
          }
        };
        
        span.setAttribute = (key, value) => {
          if (span.addLabels) {
            const labels = {};
            labels[key] = value;
            span.addLabels(labels);
          } else if (span.setLabel) {
            span.setLabel(key, value);
          }
          return span; // For method chaining
        };
        

        try {
          return callback(span);
        } finally {
          span.end();
        }
      },
      startSpan: (name) => {
        const span = apm.startSpan(name);
        
        // Add OpenTelemetry compatibility methods
        if (span) {
          // Add recordException method for OTel compatibility
          span.recordException = (error) => {
            apm.captureError(error, { handled: true });
            // Set error flag on the span
            span.setOutcome('failure');
          };
          
          // Add setStatus method for OTel compatibility
          span.setStatus = ({ code, message }) => {
            // Map OTel status codes to Elastic APM outcome
            // code 1 = OK, code 2 = ERROR in OTel
            if (code === 2 || (message && message.length > 0)) {
              span.setOutcome('failure');
            } else {
              span.setOutcome('success');
            }
          };

          span.setAttribute = (key, value) => {
            if (span.addLabels) {
              const labels = {};
              labels[key] = value;
              span.addLabels(labels);
            } else if (span.setLabel) {
              span.setLabel(key, value);
            }
            return span; // For method chaining
          };
        }
        return span;
      }
    }),
    getActiveSpan: () => {
      const activeSpan = apm.currentTransaction || apm.currentSpan;
      
      if (!activeSpan) return null;
      
      // Add spanContext method to match OpenTelemetry API
      activeSpan.spanContext = () => {
        const traceContext = activeSpan.traceparent || (activeSpan.getTraceContext && activeSpan.getTraceContext());
        return {
          traceId: (traceContext && traceContext.traceId) || activeSpan.traceId || 'unknown',
          spanId: (traceContext && traceContext.id) || activeSpan.id || 'unknown',
          traceFlags: '01'
        };
      };
      
      // Add OpenTelemetry compatibility methods
      
      // Add recordException method
      if (!activeSpan.recordException) {
        activeSpan.recordException = (error) => {
          apm.captureError(error, { handled: true });
          // Set error flag on the span
          if (activeSpan.setOutcome) {
            activeSpan.setOutcome('failure');
          }
        };
      }
      
      // Add setStatus method
      if (!activeSpan.setStatus) {
        activeSpan.setStatus = ({ code, message }) => {
          // Map OTel status codes to Elastic APM outcome
          // code 1 = OK, code 2 = ERROR in OTel
          if (activeSpan.setOutcome) {
            if (code === 2 || (message && message.length > 0)) {
              activeSpan.setOutcome('failure');
            } else {
              activeSpan.setOutcome('success');
            }
          }
        };
      }
      
      return activeSpan;
    },
  },
  context: {
    active: () => ({}),
    with: (ctx, fn) => fn(),
  },
  propagation: {
    inject: (context, carrier) => {
      if (apm.currentTransaction) {
        // Elastic APM uses different methods to access trace context
        // We'll set distributed tracing headers directly
        const traceparent = apm.currentTransaction.traceparent;
        if (traceparent) {
          carrier.traceparent = traceparent;
        }
        
        // Add any baggage if available
        if (apm.currentTransaction.baggage) {
          carrier.baggage = apm.currentTransaction.baggage;
        }
      }
    },
    extract: (context, carrier) => {
      // Elastic APM extracts from headers automatically
      return context;
    },
  },
};
