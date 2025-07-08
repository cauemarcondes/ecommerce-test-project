'use strict';

// Load Elastic APM instrumentation first
const { apm, createSpan } = require('./instrumentation');

const amqp = require('amqplib');
const { Client } = require('@elastic/elasticsearch');
const nodemailer = require('nodemailer');
const pino = require('pino');

// Environment variables
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://rabbitmq:5672';
const ELASTICSEARCH_URL = process.env.ELASTICSEARCH_URL || 'http://elasticsearch:9200';
const SERVICE_NAME = process.env.ELASTIC_APM_SERVICE_NAME || 'email-worker';
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

// Initialize Elasticsearch client
const esClient = new Client({
  node: ELASTICSEARCH_URL
})

// Setup test email transport (for simulation only)
const emailTransport = nodemailer.createTransport({
  host: 'localhost',
  port: 25,
  secure: false,
  tls: {
    rejectUnauthorized: false
  },
  // This is a simulation - no actual emails will be sent
  streamTransport: true,
  newline: 'unix'
});

// Get order from Elasticsearch
async function getOrderFromES(orderId) {
  // Create a span for the Elasticsearch operation
  const esSpan = createSpan('ES /orders/_doc');
  
  try {
    // Add label for the order ID
    esSpan.addLabels({
      'order.id': orderId
    });
    
    // Get document
    const res = await esClient.get({
      index: 'orders',
      id: orderId
    });
    
    // Mark the operation as successful
    esSpan.setOutcome('success');
    esSpan.end();
    
    // Return order data
    return res.body._source;
  } catch (err) {
    if (err.meta && err.meta.statusCode === 404) {
      apm.captureError(err);
      esSpan.addLabels({
        'error.message': `Order not found: ${orderId}`
      });
      esSpan.setOutcome('failure');
      esSpan.end();
      
      logger.warn(addTraceContext({
        message: `Order not found: ${orderId}`,
        order: { id: orderId }
      }));
      
      return null;
    }
    
    // Handle other errors
    apm.captureError(err);
    esSpan.setOutcome('failure');
    esSpan.end();
    
    logger.error(addTraceContext({
      message: `Error fetching order: ${orderId}`,
      error: { message: err.message, stack: err.stack },
      order: { id: orderId }
    }));
    
    throw err;
  }
}

// Simulate sending an email
async function sendEmail(order) {
  // Create a transaction for sending an email
  const emailTransaction = apm.startTransaction('send_confirmation_email', 'email');
  
  try {
    // Add email details as labels
    emailTransaction.addLabels({
      'email.recipient': order.customerEmail,
      'email.subject': `Your order #${order.id} has been confirmed`,
      'order.id': order.id,
      'order.amount': order.amount
    });
    
    // Generate email content
    const emailContent = {
      from: '"Mini Shop" <noreply@minishop.example.com>',
      to: order.customerEmail,
      subject: `Your order #${order.id} has been confirmed`,
      text: `Thank you for your order #${order.id}!\n\nYour order for ${order.quantity}x ${order.productName} has been confirmed and paid.\nTotal: $${order.amount.toFixed(2)}\n\nThank you for shopping with us!\nMini Shop Team`,
      html: `
        <h1>Thank you for your order #${order.id}!</h1>
        <p>Your order has been confirmed and paid:</p>
        <ul>
          <li><strong>Product:</strong> ${order.productName}</li>
          <li><strong>Quantity:</strong> ${order.quantity}</li>
          <li><strong>Total:</strong> $${order.amount.toFixed(2)}</li>
        </ul>
        <p>Thank you for shopping with us!</p>
        <p>Mini Shop Team</p>
      `
    };
    
    // Simulate email sending with small delay
    await new Promise(resolve => setTimeout(resolve, 50));
      
    // Log email sending (in production, you would actually send the email)
    const logInfo = {
      message: `Sent email to ${order.customerEmail} for order ${order.id}`,
      order: {
        id: order.id,
        amount: order.amount,
        email: order.customerEmail
      },
      email: {
        status: 'sent',
        recipient: order.customerEmail,
        subject: emailContent.subject,
        content_type: 'text/html'
      }
    };
    
    logger.info(addTraceContext(logInfo));
    
    // Mark transaction as successful
    emailTransaction.setOutcome('success');
    emailTransaction.end();
    
    return true;
  } catch (error) {
    // Capture the error with Elastic APM
    apm.captureError(error);
    emailTransaction.setOutcome('failure');
    emailTransaction.end();
    
    logger.error(addTraceContext({
      message: `Failed to send confirmation email for order ${order.id}`,
      error: { message: error.message, stack: error.stack },
      order: { id: order.id, email: order.customerEmail }
    }));
    
    throw error;
  }
}

// Process order confirmed message
async function processOrderConfirmed(msg, channel) {
  // Create a transaction for processing the message
  const transaction = apm.startTransaction('process_order_confirmed_message', 'messaging');
  
  try {
    // Parse message content
    const content = msg.content.toString();
    const order = JSON.parse(content);
    
    // Add order ID as a label
    transaction.addLabels({
      'order.id': order.id
    });
    
    logger.info(addTraceContext({
      message: `Received order.confirmed message for order ${order.id}`,
      order: { id: order.id }
    }));
    
    // Get order details from Elasticsearch
    const orderDetails = await getOrderFromES(order.id);
      
    if (!orderDetails) {
      // Acknowledge the message even if order not found, to avoid reprocessing
      channel.ack(msg);
      
      transaction.addLabels({
        'error.message': `Order not found: ${order.id}`
      });
      transaction.setOutcome('failure');
      transaction.end();
      
      return;
    }
    
    // Send confirmation email
    await sendEmail(orderDetails);
    
    // Acknowledge the message
    channel.ack(msg);
    
    // Mark transaction as successful
    transaction.setOutcome('success');
    
    logger.info(addTraceContext({
      message: `Successfully processed order ${order.id}`,
      order: { id: order.id }
    }));
    
    transaction.end();
  } catch (error) {
    // Capture error with Elastic APM
    apm.captureError(error);
    transaction.setOutcome('failure');
    
    logger.error(addTraceContext({
      message: `Error processing order confirmation for ${error.order?.id || 'unknown order'}`,
      error: { message: error.message, stack: error.stack }
    }));
    
    // Acknowledge message to avoid reprocessing failures
    // In production, you might want to use a dead-letter queue instead
    channel.ack(msg);
    
    transaction.end();
  }
}

// Connect to RabbitMQ and start consuming messages
async function startConsumer() {
  // Create a transaction for the RabbitMQ connection process
  const transaction = apm.startTransaction('connect_rabbitmq', 'messaging');
  
  let connection;
  let channel;
  let maxRetries = 10;
  let retryCount = 0;
  
  // Retry RabbitMQ connection
  while (retryCount < maxRetries) {
    try {
      logger.info(addTraceContext({
        message: `Connecting to RabbitMQ at ${RABBITMQ_URL} (attempt ${retryCount + 1}/${maxRetries})`
      }));
      
      connection = await amqp.connect(RABBITMQ_URL);
      break;
    } catch (err) {
      retryCount++;
      apm.captureError(err);
      
      logger.error(addTraceContext({
        message: `Failed to connect to RabbitMQ (attempt ${retryCount}/${maxRetries})`,
        error: { message: err.message, stack: err.stack }
      }));
      
      if (retryCount >= maxRetries) {
        transaction.setOutcome('failure');
        transaction.end();
        throw err;
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  // Setup error handler
  connection.on('error', (err) => {
    // Capture RabbitMQ errors with Elastic APM
    apm.captureError(err);
    
    logger.error(addTraceContext({
      message: 'RabbitMQ connection error',
      error: { message: err.message, stack: err.stack }
    }));
  });
  
  connection.on('close', () => {
    logger.info(addTraceContext({
      message: 'RabbitMQ connection closed'
    }));
  });
  
  // Create channel
  const channelSpan = createSpan('rabbitmq_create_channel');
  try {
    channel = await connection.createChannel();
    channelSpan.setOutcome('success');
  } catch (err) {
    apm.captureError(err);
    channelSpan.setOutcome('failure');
    throw err;
  } finally {
    channelSpan.end();
  }
  
  // Declare exchange
  const exchangeSpan = createSpan('rabbitmq_assert_exchange');
  try {
    await channel.assertExchange('orders', 'topic', {
      durable: true
    });
    exchangeSpan.setOutcome('success');
  } catch (err) {
    apm.captureError(err);
    exchangeSpan.setOutcome('failure');
    throw err;
  } finally {
    exchangeSpan.end();
  }
  
  // Declare queue
  const queueSpan = createSpan('rabbitmq_assert_queue');
  let queue;
  try {
    queue = await channel.assertQueue('order.confirmed', {
      durable: true
    });
    queueSpan.setOutcome('success');
  } catch (err) {
    apm.captureError(err);
    queueSpan.setOutcome('failure');
    throw err;
  } finally {
    queueSpan.end();
  }
  
  // Bind queue to exchange
  const bindSpan = createSpan('rabbitmq_bind_queue');
  try {
    await channel.bindQueue(queue.queue, 'orders', 'order.confirmed');
    bindSpan.setOutcome('success');
  } catch (err) {
    apm.captureError(err);
    bindSpan.setOutcome('failure');
    throw err;
  } finally {
    bindSpan.end();
  }
  
  // Set prefetch count
  await channel.prefetch(1);
  
  // Mark the initial connection as successful
  transaction.setOutcome('success');
  transaction.end();
  
  logger.info(addTraceContext({
    message: 'Successfully connected to RabbitMQ and configured consumer'
  }));
  
  // Start consuming messages
  await channel.consume(queue.queue, async (msg) => {
    if (msg) {
      // Process the message with Elastic APM tracking the transaction
      await processOrderConfirmed(msg, channel);
    }
  }, { noAck: false });
  
  logger.info(addTraceContext({
    message: 'Email worker started, listening for order.confirmed events',
    queue: queue.queue
  }));
  
  // Handle graceful shutdown
  const shutdown = async () => {
    // Create a transaction for the shutdown process
    const shutdownTransaction = apm.startTransaction('worker_shutdown', 'system');
    
    logger.info(addTraceContext({ message: 'Shutting down email worker' }));
    
    try {
      if (channel) await channel.close();
      if (connection) await connection.close();
      
      logger.info(addTraceContext({ message: 'Successfully closed RabbitMQ connections' }));
      shutdownTransaction.setOutcome('success');
    } catch (err) {
      // Capture shutdown errors
      apm.captureError(err);
      
      logger.error(addTraceContext({
        message: 'Error during shutdown',
        error: { message: err.message, stack: err.stack }
      }));
      
      shutdownTransaction.setOutcome('failure');
    } finally {
      shutdownTransaction.end();
      // Flush any remaining transactions to APM server
      apm.flush();
    }
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  
  return { connection, channel };
}

// Start the worker
async function main() {
  try {
    await startConsumer();
  } catch (err) {
    logger.fatal({
      message: 'Failed to start email worker',
      error: { message: err.message, stack: err.stack }
    });
    process.exit(1);
  }
}

// Start the application
main();
