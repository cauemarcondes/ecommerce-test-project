// Initialize Elastic APM instrumentation first
const { apm, createSpan} = require('./instrumentation');

const express = require('express');
const amqp = require('amqplib');
const { Client } = require('@elastic/elasticsearch')
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const pino = require('pino');

// Configure environment variables
const PORT = process.env.PORT || 8081;
const ELASTICSEARCH_URL = process.env.ELASTICSEARCH_URL || 'http://elasticsearch:9200';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://rabbitmq:5672';
const PAYMENT_SVC_URL = process.env.PAYMENT_SVC_URL || 'payment-svc:9000';

// Configure ECS-compatible JSON logger with trace context
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => {
      return { level: label };
    }
  },
  base: {
    service: {
      name: process.env.ELASTIC_APM_SERVICE_NAME || 'order-svc',
      version: process.env.ELASTIC_APM_SERVICE_VERSION || '0.1.0',
      environment: process.env.NODE_ENV || 'development'
    }
  },
  // Add trace.id and span.id to logs when available
  mixin() {
    // Get current transaction or span from Elastic APM
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

// Initialize Express app
const app = express();
app.use(express.json());

// Initialize Elasticsearch client
const esClient = new Client({
  node: ELASTICSEARCH_URL
})


// Load payment service proto file
const PROTO_PATH = path.join(__dirname, '../proto/payment.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});

// Create gRPC client for payment service
const paymentProto = grpc.loadPackageDefinition(packageDefinition).payment;
const paymentClient = new paymentProto.Payment(
  PAYMENT_SVC_URL,
  grpc.credentials.createInsecure()
);

// RabbitMQ connection and channel
let rabbitChannel;

// Connect to RabbitMQ
async function setupRabbitMQ() {
  try {
    const connection = await amqp.connect(RABBITMQ_URL);
    rabbitChannel = await connection.createChannel();
    
    // Declare exchange
    await rabbitChannel.assertExchange('orders', 'topic', { durable: true });
    
    // Declare queue for order.confirmed
    await rabbitChannel.assertQueue('order.confirmed', { durable: true });
    await rabbitChannel.bindQueue('order.confirmed', 'orders', 'order.confirmed');
    
    logger.info('Connected to RabbitMQ');
  } catch (error) {
    logger.error({ msg: 'Failed to connect to RabbitMQ', error: error.message });
    setTimeout(setupRabbitMQ, 5000);
  }
}

// Initialize Elasticsearch index
async function setupElasticsearch() {
  // Create transaction for Elasticsearch operations
  const transaction = apm.startTransaction('ES /orders/_create', 'db');
  
  try {
    // Check if index exists
    const indexExists = await esClient.indices.exists({ index: 'orders' });
    
    if (!indexExists.body) {
      // Create index with mapping
      await esClient.indices.create({
        index: 'orders',
        body: {
          mappings: {
            properties: {
              id: { type: 'keyword' },
              productId: { type: 'keyword' },
              productName: { type: 'text' },
              quantity: { type: 'integer' },
              amount: { type: 'float' },
              customerEmail: { type: 'keyword' },
              status: { type: 'keyword' },
              createdAt: { type: 'date' }
            }
          }
        }
      });
      logger.info('Created orders index');
    }
    transaction.setOutcome('success');
  } catch (error) {
    apm.captureError(error);
    transaction.setOutcome('failure');
    logger.error({ msg: 'Failed to setup Elasticsearch index', error: error.message });
  }
  transaction.end();
}

// Process payment via gRPC
function processPayment(orderId, amount) {
  return new Promise((resolve, reject) => {
    // Create transaction for payment processing
    const transaction = apm.startTransaction('gRPC payment.Charge', 'external');
    
    try {
      // Add labels for the payment details
      transaction.addLabels({
        'order.id': orderId,
        'payment.amount': amount
      });
      
      paymentClient.Charge({
        order_id: orderId,
        amount: amount,
        currency: 'USD'
      }, (error, response) => {
        if (error) {
          apm.captureError(error);
          transaction.setOutcome('failure');
          transaction.end();
          reject(error);
          return;
        }
    
        // Add response details as labels
        transaction.addLabels({
          'payment.status': response.status,
          'payment.transaction_id': response.transaction_id
        });
        transaction.setOutcome('success');
        transaction.end();
        
        resolve(response);
      });
    } catch (error) {
      apm.captureError(error);
      transaction.setOutcome('failure');
      transaction.end();
      reject(error);
    }
  });
}

// Publish order confirmed message
async function publishOrderConfirmed(order) {
  // Create a transaction for publishing to RabbitMQ
  const transaction = apm.startTransaction('RabbitMQ publish order.confirmed', 'messaging');
  
  try {
    if (!rabbitChannel) {
      throw new Error('RabbitMQ channel not available');
    }
    
    // Add order details as labels
    transaction.addLabels({
      'order.id': order.id
    });
    
    await rabbitChannel.publish(
      'orders',
      'order.confirmed',
      Buffer.from(JSON.stringify(order)),
      { 
        contentType: 'application/json',
        messageId: uuidv4(),
        timestamp: Math.floor(Date.now() / 1000)
      }
    );
    
    logger.info({ 
      msg: 'Published order.confirmed event',
      orderId: order.id
    });
    
    transaction.setOutcome('success');
    transaction.end();
    return true;
  } catch (error) {
    apm.captureError(error);
    transaction.setOutcome('failure');
    logger.error({ 
      msg: 'Failed to publish order.confirmed event',
      error: error.message,
      orderId: order.id
    });
    transaction.end();
    throw error;
  }
}

// API Routes
// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'UP',
    version: process.env.SERVICE_VERSION || '0.1.0',
    connections: {
      elasticsearch: Boolean(esClient),
      rabbitmq: Boolean(rabbitChannel)
    }
  });
});

// Create order endpoint
app.post('/order', async (req, res) => {
  // Create an Elastic APM transaction for order creation
  const transaction = apm.startTransaction('create_order', 'request');
  
  try {
    // Validate request
    const { productId, productName, quantity, amount, customerEmail } = req.body;
     
    if (!productId || !quantity || !amount || !customerEmail) {
      transaction.setOutcome('failure');
      transaction.end();
      return res.status(400).json({ error: 'Missing required parameters' });
    }
      
      // Create order object
      const orderId = uuidv4();
      const order = {
        id: orderId,
        productId,
        productName: productName || 'Unknown Product',
        quantity,
        amount,
        customerEmail,
        status: 'pending',
        createdAt: new Date().toISOString()
      };
      
      // Add order details as transaction labels
      transaction.addLabels({
        'order.id': orderId,
        'order.product_id': productId,
        'order.amount': amount,
        'order.customer_email': customerEmail
      });
      
      // Process payment
      logger.info({ 
        msg: 'Processing payment',
        orderId,
        amount
      });
      
      const paymentResult = await processPayment(orderId, amount);
    
      if (paymentResult.status !== 'APPROVED') {
        order.status = 'payment_failed';
        
        // Save failed order to Elasticsearch
        const esSpan = apm.startSpan('ES /orders/_doc');
        
        try {
          await esClient.index({
            index: 'orders',
            id: orderId,
            body: order,
            refresh: true
          });
          esSpan.setOutcome('success');
        } catch (error) {
          esSpan.setOutcome('failure');
          throw error;
        } finally {
          esSpan.end();
        }
        
        transaction.addLabels({
          'error': true,
          'payment.status': paymentResult.status
        });
        
        transaction.setOutcome('failure');
        transaction.end();
        
        logger.warn({ 
          msg: 'Payment declined',
          orderId,
          paymentStatus: paymentResult.status,
          message: paymentResult.message
        });
        
        return res.status(400).json({
          error: 'Payment declined',
          orderId,
          status: order.status,
          message: paymentResult.message
        });
      }
    
      // Payment successful, update order status
      order.status = 'confirmed';
      order.paymentId = paymentResult.transaction_id;
      
      // Save order to Elasticsearch
      const esSpan = apm.startSpan('ES /orders/_doc');
      
      try {
        await esClient.index({
          index: 'orders',
          id: orderId,
          body: order,
          refresh: true
        });
        esSpan.setOutcome('success');
      } catch (error) {
        esSpan.setOutcome('failure');
        throw error;
      } finally {
        esSpan.end();
      }
      
      // Publish order confirmed event
      await publishOrderConfirmed(order);
      
      // Set successful outcome and end the transaction
      transaction.addLabels({
        'payment.transaction_id': paymentResult.transaction_id
      });
      transaction.setOutcome('success');
      transaction.end();
      
      // Return success response
      return res.status(201).json({
        orderId,
        status: order.status
      });
    } catch (error) {
      // Capture the error and end the transaction
      apm.captureError(error);
      transaction.setOutcome('failure');
      transaction.end();
      
      logger.error({
        msg: 'Failed to create order', 
        error: error.message,
        stack: error.stack
      });
      
      return res.status(500).json({
        error: 'Failed to process order'
      });
    }
});

// Get order by ID
app.get('/order/:id', async (req, res) => {
  const orderId = req.params.id;
  // Create a transaction for getting an order
  const transaction = apm.startTransaction('get_order', 'request');
  
  // Add order ID as a label
  transaction.addLabels({
    'order.id': orderId
  });
  
  try {
    // Create a span for Elasticsearch operation
    const esSpan = createSpan('ES /orders/_get');
    
    let result;
    try {
      result = await esClient.get({
        index: 'orders',
        id: orderId
      });
      esSpan.setOutcome('success');
    } catch (error) {
      esSpan.setOutcome('failure');
      throw error;
    } finally {
      esSpan.end();
    }
    
    if (!result.body || !result.body._source) {
      transaction.setOutcome('failure');
      transaction.end();
      return res.status(404).json({ error: 'Order not found' });
    }
    
    // Success response
    transaction.setOutcome('success');
    transaction.end();
    return res.json(result.body._source);
    
  } catch (error) {
    // Capture the error
    apm.captureError(error);
    transaction.setOutcome('failure');
    transaction.end();
    
    logger.error({ 
      msg: `Failed to fetch order ${orderId}`,
      error: error.message
    });
    
    if (error.statusCode === 404) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    return res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// Start the application
async function start() {
  try {
    // Setup connections
    await setupElasticsearch();
    await setupRabbitMQ();
    
    // Start server
    app.listen(PORT, () => {
      logger.info(`Order service listening on port ${PORT}`);
    });
  } catch (error) {
    logger.error({ msg: 'Failed to start service', error: error.message });
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Service shutting down');
  if (rabbitChannel) {
    await rabbitChannel.close();
  }
  process.exit(0);
});

start();
