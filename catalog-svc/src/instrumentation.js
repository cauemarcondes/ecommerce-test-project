'use strict';

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { W3CTraceContextPropagator, CompositePropagator, W3CBaggagePropagator } = require('@opentelemetry/core');

// Read from environment variables
const serviceName = process.env.OTEL_SERVICE_NAME || 'catalog-svc';
const serviceVersion = process.env.SERVICE_VERSION || '0.1.0';
const environment = process.env.NODE_ENV || 'development';

// Create a custom exporter
const traceExporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://host.docker.internal:4317',
});

// Configure the SDK with the exporter and the custom resource attributes
const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    [SemanticResourceAttributes.SERVICE_VERSION]: serviceVersion,
    'deployment.environment': environment,
  }),
  traceExporter,
  instrumentations: [
    // Add Express and HTTP instrumentations
    new HttpInstrumentation(),
    new ExpressInstrumentation(),
    // Auto-instrument other common libraries
    getNodeAutoInstrumentations({
      // Configure specific instrumentations if needed
      '@opentelemetry/instrumentation-fs': {
        enabled: false,
      },
    }),
  ],
  // Configure a custom propagator that includes W3C TraceContext and Baggage
  textMapPropagator: new CompositePropagator({
    propagators: [
      new W3CTraceContextPropagator(),
      new W3CBaggagePropagator(),
    ],
  }),
});

// Initialize the SDK
sdk.start();

// Graceful shutdown
process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('OpenTelemetry SDK shut down successfully'))
    .catch((error) => console.error('Error shutting down OpenTelemetry SDK', error))
    .finally(() => process.exit(0));
});

console.log(`OpenTelemetry instrumentation initialized for ${serviceName} (${serviceVersion})`);
