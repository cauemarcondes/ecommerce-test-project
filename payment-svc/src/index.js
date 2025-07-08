'use strict';

const { loadInstrumentation } = require('./instrumentation-switch');
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'payment-svc';
const { trace } = loadInstrumentation(SERVICE_NAME)

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { v4: uuidv4 } = require('uuid');
const { SpanStatusCode } = require('@opentelemetry/api');
const pino = require('pino');

// Constants for payment status
const STATUS = {
  APPROVED: 0,
  DECLINED: 1,
  ERROR: 2
};

// Environment variables
const PORT = process.env.PORT || 9000;
const SERVICE_VERSION = process.env.SERVICE_VERSION || '0.1.0';

// Initialize tracer
const tracer = trace.getTracer('payment-svc-tracer');

// Initialize logger with ECS formatting
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: () => `,"@timestamp":"${new Date().toISOString()}"`,
  formatters: {
    level(label) {
      return { log: { level: label } };
    }
  },
  base: {
    service: {
      name: SERVICE_NAME,
      version: SERVICE_VERSION
    },
    event: {
      dataset: 'payment.log'
    }
  }
});

// Helper to add trace context to logs
function addTraceContext(span, log = {}) {
  if (!span || !span.spanContext) return log;
  
  const spanContext = span.spanContext();
  if (spanContext.traceId) {
    return {
      ...log,
      trace: { id: spanContext.traceId },
      span: { id: spanContext.spanId }
    };
  }
  return log;
}

// Load the protobuf definition
const packageDefinition = protoLoader.loadSync(
  path.resolve(__dirname, '../proto/payment.proto'),
  {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  }
);
const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
const paymentProto = protoDescriptor.payment;

// Simulate a payment gateway with artificial delays and failures
async function simulatePaymentGateway(amount, span) {
  return new Promise((resolve, reject) => {
    // Add attributes to the span
    span.setAttribute('payment.amount', amount);
    
    // Add artificial delay (25-200ms)
    const delay = 25 + Math.floor(Math.random() * 175);
    setTimeout(() => {
      // // Randomly simulate gateway errors (10% chance)
      // if (Math.random() < 0.1) {
      //   const error = new Error('Payment gateway connection timeout');
      //   span.recordException(error);
      //   span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      //   return reject(error);
      // }
      
      // // For high amount payments (>1000), simulate declined payments more often
      // if (amount > 1000 && Math.random() < 0.3) {
      //   span.setAttribute('payment.declined_reason', 'amount_too_high');
      //   return resolve(STATUS.DECLINED);
      // }
      
      // // Normal transaction flow, 10% decline rate
      // if (Math.random() < 0.1) {
      //   span.setAttribute('payment.declined_reason', 'random_decline');
      //   return resolve(STATUS.DECLINED);
      // }
      
      // Payment approved
      return resolve(STATUS.APPROVED);
    }, delay);
  });
}

// Process a payment charge with retry logic and span links
async function processPaymentWithRetry(call) {
  return await tracer.startActiveSpan('payment_process', async (parentSpan) => {
    try {
      const { order_id, amount, currency } = call.request;
      
      // Add attributes to the parent span
      parentSpan.setAttribute('payment.order_id', order_id);
      parentSpan.setAttribute('payment.amount', amount);
      parentSpan.setAttribute('payment.currency', currency);
      
      // Generate transaction ID
      const transactionId = uuidv4();
      parentSpan.setAttribute('payment.transaction_id', transactionId);
      
      // Payment info for logging
      const paymentInfo = {
        payment: {
          order_id: order_id,
          amount: amount,
          currency: currency,
          transaction_id: transactionId
        }
      };
      
      // Log payment processing start
      logger.info(addTraceContext(parentSpan, {
        message: 'Processing payment',
        ...paymentInfo
      }));
      
      // Retry configuration
      const maxRetries = 3;
      let lastError = null;
      
      // Retry logic with span links
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        // Create a span for this attempt
        const attemptResult = await tracer.startActiveSpan(
          `payment_attempt_${attempt + 1}`, 
          { attributes: { 
              'payment.attempt': attempt + 1,
              'payment.transaction_id': transactionId 
            }
          }, 
          async (attemptSpan) => {
            try {
              // Process the gateway request in a child span
              const gatewayResult = await tracer.startActiveSpan(
                'payment_gateway_request',
                async (gatewaySpan) => {
                  try {
                    return await simulatePaymentGateway(amount, gatewaySpan);
                  } catch (error) {
                    throw error;
                  } finally {
                    gatewaySpan.end();
                  }
                }
              );
              
              // Handle the result based on status
              if (gatewayResult === STATUS.APPROVED) {
                // Payment approved
                attemptSpan.setAttribute('payment.status', 'APPROVED');
                attemptSpan.setStatus({ code: SpanStatusCode.OK, message: 'Payment approved' });
                
                paymentInfo.payment.status = 'APPROVED';
                logger.info(addTraceContext(attemptSpan, {
                  message: 'Payment approved',
                  ...paymentInfo
                }));
                
                return {
                  status: STATUS.APPROVED,
                  transaction_id: transactionId,
                  message: 'Payment approved'
                };
              } else {
                // Payment declined
                attemptSpan.setAttribute('payment.status', 'DECLINED');
                attemptSpan.setStatus({ code: SpanStatusCode.OK, message: 'Payment declined' });
                
                paymentInfo.payment.status = 'DECLINED';
                logger.warn(addTraceContext(attemptSpan, {
                  message: 'Payment declined',
                  ...paymentInfo
                }));
                
                return {
                  status: STATUS.DECLINED,
                  transaction_id: transactionId,
                  message: 'Payment declined by processor'
                };
              }
            } catch (error) {
              // Payment attempt failed
              attemptSpan.recordException(error);
              attemptSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
              
              lastError = error;
              logger.error(addTraceContext(attemptSpan, {
                message: `Payment attempt ${attempt + 1} failed`,
                error: { message: error.message },
                ...paymentInfo
              }));
              
              // Add delay before retry
              await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
              return null; // Null indicates retry needed
            } finally {
              attemptSpan.end();
            }
          }
        );
        
        // If we got a result, return it
        if (attemptResult !== null) {
          // Set parent span status based on final result
          if (attemptResult.status === STATUS.APPROVED) {
            parentSpan.setStatus({ code: SpanStatusCode.OK, message: 'Payment approved' });
          } else {
            parentSpan.setStatus({ code: SpanStatusCode.OK, message: 'Payment declined' });
          }
          
          return attemptResult;
        }
      }
      
      // All retries failed
      parentSpan.recordException(lastError);
      parentSpan.setStatus({ 
        code: SpanStatusCode.ERROR, 
        message: 'Payment processing failed after retries' 
      });
      
      paymentInfo.payment.status = 'ERROR';
      logger.error(addTraceContext(parentSpan, {
        message: 'Payment processing failed after retries',
        error: { message: lastError.message },
        ...paymentInfo
      }));
      
      return {
        status: STATUS.ERROR,
        transaction_id: transactionId,
        message: 'Payment processing failed after multiple attempts'
      };
    } catch (error) {
      // Unexpected error
      parentSpan.recordException(error);
      parentSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      
      logger.error(addTraceContext(parentSpan, {
        message: 'Unexpected error during payment processing',
        error: { message: error.message }
      }));
      
      return {
        status: STATUS.ERROR,
        transaction_id: uuidv4(),
        message: 'Unexpected error during payment processing'
      };
    } finally {
      parentSpan.end();
    }
  });
}

// Implement the gRPC service
const paymentService = {
  charge: async (call, callback) => {
    try {
      const result = await processPaymentWithRetry(call);
      callback(null, result);
    } catch (error) {
      logger.error({
        message: 'Error processing payment charge',
        error: { message: error.message }
      });
      
      callback({
        code: grpc.status.INTERNAL,
        message: 'Internal server error during payment processing'
      });
    }
  }
};

// Start the gRPC server
function startServer() {
  const server = new grpc.Server();
  server.addService(paymentProto.Payment.service, paymentService);
  
  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (error, port) => {
      if (error) {
        logger.error({ 
          message: 'Failed to start gRPC server', 
          error: { message: error.message } 
        });
        return;
      }
      
      server.start();
      logger.info({
        message: `Payment gRPC server started on port ${port}`,
        service: {
          name: SERVICE_NAME,
          version: SERVICE_VERSION
        }
      });
    }
  );
  
  // Graceful shutdown
  const shutdown = () => {
    logger.info({ message: 'Shutting down gRPC server' });
    server.tryShutdown(() => {
      logger.info({ message: 'gRPC server shut down successfully' });
      process.exit(0);
    });
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Start the server
startServer();
