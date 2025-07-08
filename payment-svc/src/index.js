'use strict';

// Load Elastic APM instrumentation first
const { apm, createSpan } = require('./instrumentation');

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { v4: uuidv4 } = require('uuid');
const pino = require('pino');

// Constants for payment status
const STATUS = {
  APPROVED: 0,
  DECLINED: 1,
  ERROR: 2
};

// Environment variables
const PORT = process.env.PORT || 9000;
const SERVICE_NAME = process.env.ELASTIC_APM_SERVICE_NAME || 'payment-svc';
const SERVICE_VERSION = process.env.ELASTIC_APM_SERVICE_VERSION || '0.1.0';

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
    }
  },
  // Add trace.id and span.id to logs when available
  mixin() {
    const currentTransaction = apm.currentTransaction;
    const currentSpan = apm.currentSpan;
    const activeSpan = currentSpan || currentTransaction;
    
    if (!activeSpan) return {};

    return {
      trace: { id: activeSpan.traceId },
      span: { id: activeSpan.id }
    };
  }
});

// Helper to add trace context to logs
function addTraceContext(log = {}) {
  const currentTransaction = apm.currentTransaction;
  const currentSpan = apm.currentSpan;
  const activeSpan = currentSpan || currentTransaction;
  
  if (!activeSpan) return log;
  
  return {
    ...log,
    trace: { id: activeSpan.traceId },
    span: { id: activeSpan.id }
  };
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
async function simulatePaymentGateway(amount) {
  return new Promise((resolve, reject) => {
    // Create a span for the payment gateway operation
    const span = createSpan('payment_gateway_request');
    
    // Add labels to the span
    span.addLabels({
      'payment.amount': amount
    });
    
    // Add artificial delay (25-200ms)
    const delay = 25 + Math.floor(Math.random() * 175);
    setTimeout(() => {
      // // Randomly simulate gateway errors (10% chance)
      // if (Math.random() < 0.1) {
      //   const error = new Error('Payment gateway connection timeout');
      //   apm.captureError(error);
      //   span.setOutcome('failure');
      //   span.end();
      //   return reject(error);
      // }
      
      // // For high amount payments (>1000), simulate declined payments more often
      // if (amount > 1000 && Math.random() < 0.3) {
      //   span.addLabels({'payment.declined_reason': 'amount_too_high'});
      //   span.setOutcome('success');
      //   span.end();
      //   return resolve(STATUS.DECLINED);
      // }
      
      // // Normal transaction flow, 10% decline rate
      // if (Math.random() < 0.1) {
      //   span.addLabels({'payment.declined_reason': 'random_decline'});
      //   span.setOutcome('success');
      //   span.end();
      //   return resolve(STATUS.DECLINED);
      // }
      
      // Payment approved
      span.setOutcome('success');
      span.end();
      return resolve(STATUS.APPROVED);
    }, delay);
  });
}

// Process a payment charge with retry logic and span links
async function processPaymentWithRetry(call) {
  // Create a transaction for processing a payment
  const transaction = apm.startTransaction('payment_process', 'request');
  
  try {
    const { order_id, amount, currency } = call.request;
    
    // Add labels to the transaction
    transaction.addLabels({
      'payment.order_id': order_id,
      'payment.amount': amount,
      'payment.currency': currency
    });
    
    // Generate transaction ID
    const transactionId = uuidv4();
    transaction.addLabels({
      'payment.transaction_id': transactionId
    });
    
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
    logger.info(addTraceContext({
      message: 'Processing payment',
      ...paymentInfo
    }));
    
    // Retry configuration
    const maxRetries = 3;
    let lastError = null;
    let result = null;
    
    // Retry logic with spans for each attempt
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Create a span for this attempt
      const attemptSpan = createSpan(`payment_attempt_${attempt + 1}`);
      
      // Add attempt information to the span
      attemptSpan.addLabels({ 
        'payment.attempt': attempt + 1,
        'payment.transaction_id': transactionId 
      });
      
      try {
        // Process the payment using the gateway simulation
        const gatewayResult = await simulatePaymentGateway(amount);
        
        // Process gateway result
        if (gatewayResult === STATUS.APPROVED) {
          attemptSpan.addLabels({
            'payment.status': 'approved'
          });
          attemptSpan.setOutcome('success');
          
          result = {
            status: 'APPROVED',
            transaction_id: transactionId
          };
          
          // End the span for this attempt
          attemptSpan.end();
          
          // Success! Break the retry loop
          break;
        } else {
          // Payment was declined
          attemptSpan.addLabels({
            'payment.status': 'declined'
          });
          
          lastError = new Error('Payment declined by gateway');
          attemptSpan.setOutcome('failure');
          attemptSpan.end();
          
          throw lastError;
        }
      } catch (error) {
        // Capture the error
        apm.captureError(error);
        attemptSpan.setOutcome('failure');
        attemptSpan.end();
        
        // Save for retry logic
        lastError = error;
        
        // Log the error
        logger.warn(addTraceContext({
          message: `Payment attempt ${attempt + 1} failed`,
          attempt: attempt + 1,
          error: error.message,
          ...paymentInfo
        }));
        
        // Determine if we should retry
        if (attempt === maxRetries - 1) {
          // Last attempt failed
          break;
        }
        
        // Add delay before retry (exponential backoff)
        const delay = 100 * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // Process final result
    if (result) {
      // Payment succeeded
      logger.info(addTraceContext({
        message: 'Payment processed successfully',
        status: 'APPROVED',
        ...paymentInfo
      }));
      
      transaction.setOutcome('success');
      transaction.end();
      
      return result;
    } else {
      // All retries failed
      logger.error(addTraceContext({
        message: 'Payment processing failed after retries',
        attempts: maxRetries,
        error: lastError.message,
        ...paymentInfo
      }));
      
      transaction.setOutcome('failure');
      transaction.end();
      
      return {
        status: 'ERROR',
        message: lastError.message
      };
    }
  } catch (error) {
    // Unexpected error
    apm.captureError(error);
    
    logger.error(addTraceContext({
      message: 'Unexpected error during payment processing',
      error: { message: error.message, stack: error.stack },
      ...paymentInfo
    }));
    
    transaction.setOutcome('failure');
    transaction.end();
    
    return {
      status: 'ERROR',
      message: error.message
    };
  }
}

// Implement the gRPC service
const paymentService = {
  charge: async (call, callback) => {
    // Note: We don't need to create a transaction here as processPaymentWithRetry already creates one
    try {
      const result = await processPaymentWithRetry(call);
      callback(null, result);
    } catch (error) {
      // Capture the error with Elastic APM
      apm.captureError(error);
      
      logger.error(addTraceContext({
        message: 'Error processing payment charge',
        error: { message: error.message }
      }));
      
      callback({
        code: grpc.status.INTERNAL,
        message: 'Internal server error during payment processing'
      });
    }
  }
};

// Start the gRPC server
function startServer() {
  // Create a transaction for server startup
  const transaction = apm.startTransaction('server_start', 'system');
  
  const server = new grpc.Server();
  server.addService(paymentProto.Payment.service, paymentService);
  
  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (error, port) => {
      if (error) {
        apm.captureError(error);
        transaction.setOutcome('failure');
        transaction.end();
        
        logger.error(addTraceContext({ 
          message: 'Failed to start gRPC server', 
          error: { message: error.message } 
        }));
        return;
      }
      
      server.start();
      
      transaction.setOutcome('success');
      transaction.end();
      
      logger.info(addTraceContext({
        message: `Payment gRPC server started on port ${port}`,
        service: {
          name: SERVICE_NAME,
          version: SERVICE_VERSION
        }
      }));
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
