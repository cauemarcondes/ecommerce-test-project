// OpenTelemetry instrumentation for the API Gateway
const process = require('process');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { W3CTraceContextPropagator, W3CBaggagePropagator, CompositePropagator } = require('@opentelemetry/core');
const { trace, context, propagation } = require('@opentelemetry/api');

const serviceName = process.env.OTEL_SERVICE_NAME || 'api-gateway';
const serviceVersion = process.env.SERVICE_VERSION || '0.1.0';
const environment = process.env.NODE_ENV || 'development';


// Configure the SDK to export telemetry data to the OTel Collector
// using OTLP over HTTP
const traceExporter = new OTLPTraceExporter({
  url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://host.docker.internal:4318'}/v1/traces`,
  headers: {},
});

// Initialize the SDK
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
  textMapPropagator: new CompositePropagator({
    propagators: [
      new W3CTraceContextPropagator(),
      new W3CBaggagePropagator(),
    ],
  }),
});

// Initialize the SDK and register with the OpenTelemetry API
sdk.start();
process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('OpenTelemetry SDK shut down successfully'))
    .catch((error) => console.error('Error shutting down OpenTelemetry SDK', error))
    .finally(() => process.exit(0));
});

console.log(`OpenTelemetry instrumentation initialized for ${serviceName} (${serviceVersion})`);

// Export the trace API for manual instrumentation
module.exports = { trace, context, propagation };
