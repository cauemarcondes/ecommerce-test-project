// Initialize Elastic APM instrumentation first
const { apm, createSpan, getCurrentTransaction, getCurrentSpan, addLabels, captureError } = require('./instrumentation');

const express = require('express');
const axios = require('axios');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;
const CATALOG_SVC_URL = process.env.CATALOG_SVC_URL || 'http://catalog-svc:8080';
const ORDER_SVC_URL = process.env.ORDER_SVC_URL || 'http://order-svc:8081';
const GIT_SHA = process.env.GIT_SHA || '1';//require('child_process').execSync('git rev-parse --short HEAD').toString().trim();
const SERVICE_NAME = process.env.ELASTIC_APM_SERVICE_NAME || 'api-gateway';
const SERVICE_VERSION = process.env.ELASTIC_APM_SERVICE_VERSION || '0.1.0';

// Configure ECS-compatible JSON logger with trace context
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: () => `,"@timestamp":"${new Date().toISOString()}"`,
  formatters: {
    level: (label) => {
      return { level: label };
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

// Middleware
app.use(express.json());

// Add trace context to all requests
// app.use((req, res, next) => {
//   // Add W3C trace-context headers and custom baggage
//   const baggage = propagation.createBaggage({
//     release: { value: GIT_SHA }
//   });
  
//   // Get active context and set baggage on it
//   const activeContext = context.active();
//   const contextWithBaggage = activeContext.setValue('baggage', baggage);
  
//   // Continue with updated context
//   context.with(
//     contextWithBaggage,
//     () => next()
//   );
// });

// Log all requests
app.use((req, res, next) => {
  logger.info({
    msg: `Incoming request: ${req.method} ${req.url}`,
    http: {
      method: req.method,
      url: req.url,
      user_agent: req.headers['user-agent']
    }
  });
  next();
});

// Helper to propagate trace context in outgoing requests
function injectTraceContext(config) {
  const headers = {};
  const currentTransaction = apm.currentTransaction;
  
  if (currentTransaction && currentTransaction.traceparent) {
    headers.traceparent = currentTransaction.traceparent;
  }
  
  config.headers = { ...config.headers, ...headers };
  return config;
}

// GET /products - List all products
app.get('/products', async (req, res) => {
  try {
    const response = await axios.get(
      `${CATALOG_SVC_URL}/products`,
      injectTraceContext({})
    );
    res.json(response.data);
  } catch (error) {
    logger.error({
      msg: 'Error fetching products',
      error: error.message
    });
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// GET /products/:id - Get a specific product
app.get('/products/:id', async (req, res) => {
  try {
    const response = await axios.get(
      `${CATALOG_SVC_URL}/product/${req.params.id}`,
      injectTraceContext({})
    );
    res.json(response.data);
  } catch (error) {
    logger.error({
      msg: `Error fetching product ${req.params.id}`,
      error: error.message
    });
    if (error.response && error.response.status === 404) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.status(500).json({ error: 'Failed to fetch product details' });
  }
});

// POST /checkout - Process order checkout
app.post('/checkout', async (req, res) => {
  // Create an APM transaction for the checkout process
  const transaction = apm.startTransaction('checkout', 'request');
  
  try {
    // Validate request
    const { productId, quantity, customerEmail } = req.body;
    
    if (!productId || !quantity || !customerEmail) {
      logger.warn({
        msg: 'Invalid checkout request',
        request: { ...req.body }
      });
      transaction.setOutcome('failure');
      transaction.end();
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Fetch product information
    logger.info({
      msg: `Fetching product ${productId} for checkout`
    });

    // Create a span for fetching product details
    const productSpan = createSpan('fetch_product');
    try {
      const productResponse = await axios.get(
        `${CATALOG_SVC_URL}/products/${productId}`,
        injectTraceContext({})
      );
      
      const product = productResponse.data;
      const totalAmount = product.price * quantity;

      // Add labels for Elastic APM
      transaction.addLabels({
        'order.product_id': productId,
        'order.quantity': quantity,
        'order.amount': totalAmount,
        'order.customer_email': customerEmail
      });

      productSpan.setOutcome('success');
      productSpan.end();

      // Create order
      logger.info({
        msg: 'Creating order',
        order: {
          product_id: productId,
          amount: totalAmount,
          email: customerEmail
        }
      });

      // Create a span for order creation
      const orderSpan = createSpan('create_order');
      try {
        const orderResponse = await axios.post(
          `${ORDER_SVC_URL}/order`,
          {
            productId,
            productName: product.name,
            quantity,
            amount: totalAmount,
            customerEmail
          },
          injectTraceContext({})
        );

        const orderData = orderResponse.data;
        transaction.addLabels({
          'order.id': orderData.id
        });
        
        orderSpan.setOutcome('success');
        orderSpan.end();
        
        transaction.setOutcome('success');
        transaction.end();
        
        res.status(201).json({
          success: true,
          message: 'Order created successfully',
          orderId: orderData.id,
          amount: totalAmount,
          status: orderData.status
        });
      } catch (error) {
        orderSpan.setOutcome('failure');
        orderSpan.end();
        throw error;
      }
    } catch (error) {
      if (productSpan) {
        productSpan.setOutcome('failure');
        productSpan.end();
      }
      throw error;
    }
  } catch (error) {
    logger.error({
      msg: 'Checkout process failed',
      error: error.message,
      stack: error.stack
    });
    
    apm.captureError(error);
    transaction.setOutcome('failure');
    transaction.end();
    
    const status = error.response?.status || 500;
    const message = error.response?.data?.error || 'Checkout process failed';
    
    res.status(status).json({ error: message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'UP', version: process.env.SERVICE_VERSION || '0.1.0' });
});

async function startServer() {
  try {
    app.listen(PORT, () => {
      logger.info({
        message: `API Gateway started on port ${PORT}`,
        service: {
          name: SERVICE_NAME,
          version: SERVICE_VERSION
        }
      });
    });
    
    // Graceful shutdown
    const shutdown = () => {
      logger.info({ message: 'Shutting down API Gateway' });
      process.exit(0);
    };
    
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    logger.error({
      message: 'Failed to start API Gateway',
      error: { message: err.message, stack: err.stack }
    });
    process.exit(1);
  }
}

startServer();
