'use strict';

// Load Elastic APM instrumentation first
const { apm, createSpan } = require('./instrumentation');

const express = require('express');
const { Client } = require('@elastic/elasticsearch');
const pino = require('pino');
const pinoHttp = require('pino-http');

// Environment variables
const PORT = process.env.PORT || 8080;
const ELASTICSEARCH_URL = process.env.ELASTICSEARCH_URL || 'http://elasticsearch:9200';
const SERVICE_NAME = process.env.ELASTIC_APM_SERVICE_NAME || 'catalog-svc';
const SERVICE_VERSION = process.env.ELASTIC_APM_SERVICE_VERSION || '0.1.0';
const ES_INDEX = 'catalog';

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

// Sample product data for seeding
const sampleProducts = [
  {
    id: '1',
    name: 'Windsurf Laptop Pro',
    description: 'Powerful laptop for developers with the latest specs',
    price: 1299.99,
    category: 'electronics',
    imageUrl: 'https://example.com/images/laptop.jpg',
    tags: ['laptop', 'development', 'high-performance'],
    inventory: 50
  },
  {
    id: '2',
    name: 'Cascade AI Assistant',
    description: 'Smart AI assistant for your home',
    price: 249.99,
    category: 'electronics',
    imageUrl: 'https://example.com/images/ai-assistant.jpg',
    tags: ['ai', 'smart-home', 'assistant'],
    inventory: 100
  },
  {
    id: '3',
    name: 'OpenTelemetry Guide Book',
    description: 'Comprehensive guide to OpenTelemetry observability',
    price: 39.99,
    category: 'books',
    imageUrl: 'https://example.com/images/otel-book.jpg',
    tags: ['book', 'observability', 'monitoring'],
    inventory: 200
  },
  {
    id: '4',
    name: 'Elastic APM T-Shirt',
    description: 'Comfortable t-shirt with Elastic APM logo',
    price: 19.99,
    category: 'clothing',
    imageUrl: 'https://example.com/images/elastic-tshirt.jpg',
    tags: ['clothing', 'apparel', 'swag'],
    inventory: 75
  },
  {
    id: '5',
    name: 'Observability Platform - 1 Year License',
    description: 'Enterprise license for the full observability platform',
    price: 3999.99,
    category: 'software',
    imageUrl: 'https://example.com/images/obs-platform.jpg',
    tags: ['software', 'enterprise', 'license'],
    inventory: 25
  }
];

// Initialize Express app
const app = express();
app.use(express.json());

// Add request logging middleware
app.use(pinoHttp({
  logger,
  // Customize the logging to include trace context
  customLogLevel: function (req, res, err) {
    if (res.statusCode >= 500 || err) {
      return 'error';
    } else if (res.statusCode >= 400) {
      return 'warn';
    }
    return 'info';
  },
  // Add custom props to each log
  customProps: function (req, res) {
    const currentTransaction = apm.currentTransaction;
    const currentSpan = apm.currentSpan;
    const activeSpan = currentSpan || currentTransaction;
    
    if (activeSpan) {
      return {
        trace: { id: activeSpan.traceId },
        span: { id: activeSpan.id }
      };
    }
    return {};
  }
}));

// Check Elasticsearch connectivity and create index/seed data if needed
async function setupElasticsearch() {
  // Create a transaction for the Elasticsearch setup
  const transaction = apm.startTransaction('setup_elasticsearch', 'db');
  
  try {
    logger.info(addTraceContext({
      message: 'Checking Elasticsearch connectivity'
    }));
    
    // Check if Elasticsearch is up
    const healthRes = await esClient.cluster.health();
    if (healthRes.status === 'red') {
      throw new Error('Elasticsearch cluster is in red status');
    }
    
    logger.info(addTraceContext({
      message: 'Elasticsearch is healthy',
      cluster: { status: healthRes.status }
    }));
    
    // Check if catalog index exists
    // Create a span for checking the index
    const indexSpan = createSpan('ES /_cat/indices');
    
    let indexExists;
    try {
      const res = await esClient.indices.exists({ index: ES_INDEX });
      indexExists = res;
      indexSpan.setOutcome('success');
    } catch (err) {
      apm.captureError(err);
      indexSpan.setOutcome('failure');
      throw err;
    } finally {
      indexSpan.end();
    }
    
    // Create index if it doesn't exist
    if (!indexExists) {
      // Create a span for creating the index
      const createIndexSpan = createSpan('ES /catalog');
      
      try {
        logger.info(addTraceContext({
          message: `Creating ${ES_INDEX} index`
        }));
        
        await esClient.indices.create({
          index: ES_INDEX,
          body: {
            mappings: {
              properties: {
                id: { type: 'keyword' },
                name: { type: 'text' },
                description: { type: 'text' },
                price: { type: 'float' },
                category: { type: 'keyword' },
                imageUrl: { type: 'keyword' },
                tags: { type: 'keyword' },
                inventory: { type: 'integer' }
              }
            }
          }
        });
        
        logger.info(addTraceContext({
          message: `${ES_INDEX} index created`
        }));
        
        // Seed sample data
        await seedSampleData();
        createIndexSpan.setOutcome('success');
      } catch (err) {
        apm.captureError(err);
        createIndexSpan.setOutcome('failure');
        throw err;
      } finally {
        createIndexSpan.end();
      }
    } else {
      logger.info(addTraceContext({
        message: `${ES_INDEX} index already exists`
      }));
      
      // Check if we need to seed data
      const countRes = await esClient.count({ index: ES_INDEX });
      if (countRes.count === 0) {
        await seedSampleData();
      } else {
        logger.info(addTraceContext({
          message: `${ES_INDEX} index already contains ${countRes.count} products`
        }));
      }
    }
    
    logger.info(addTraceContext({
      message: 'Elasticsearch setup complete'
    }));
    
    transaction.setOutcome('success');
  } catch (err) {
    apm.captureError(err);
    transaction.setOutcome('failure');
    logger.error(addTraceContext({
      message: 'Failed to set up Elasticsearch',
      error: { message: err.message, stack: err.stack }
    }));
    throw err;
  } finally {
    transaction.end();
  }
}

// Seed sample product data
async function seedSampleData() {
  // Create a transaction for seeding sample data
  const transaction = apm.startTransaction('seed_sample_data', 'db');
  
  try {
    logger.info(addTraceContext({
      message: `Seeding ${sampleProducts.length} sample products`
    }));
    
    const bulkBody = [];
    sampleProducts.forEach(product => {
      bulkBody.push(
        { index: { _index: ES_INDEX, _id: product.id } },
        product
      );
    });
    
    // Create a span for bulk insertion
    const bulkSpan = createSpan('ES /catalog/_bulk');
    
    try {
      const res = await esClient.bulk({
        body: bulkBody,
        refresh: true
      });
      
      if (res.errors) {
        throw new Error(`Bulk indexing had errors: ${JSON.stringify(res.errors)}`);
      }
      
      logger.info(addTraceContext({
        message: `Successfully seeded ${sampleProducts.length} products`
      }));
      
      bulkSpan.setOutcome('success');
    } catch (err) {
      apm.captureError(err);
      bulkSpan.setOutcome('failure');
      throw err;
    } finally {
      bulkSpan.end();
    }
    
    transaction.setOutcome('success');
  } catch (err) {
    apm.captureError(err);
    transaction.setOutcome('failure');
    
    logger.error(addTraceContext({
      message: 'Failed to seed sample data',
      error: { message: err.message, stack: err.stack }
    }));
    
    throw err;
  } finally {
    transaction.end();
  }
}

// Define API endpoints

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    service: SERVICE_NAME,
    version: SERVICE_VERSION
  });
});

// List all products
app.get('/products', async (req, res) => {
  // Create transaction for listing products
  const transaction = apm.startTransaction('list_products', 'request');
  
  try {
    logger.info(addTraceContext({
      message: 'Listing all products'
    }));
    
    // Create span for Elasticsearch search
    const searchSpan = createSpan('ES /catalog/_search');
    
    let searchRes;
    try {
      // Prepare search query
      const query = {
        query: { match_all: {} },
        size: 100
      };
      
      // Perform search
      searchRes = await esClient.search({
        index: ES_INDEX,
        body: query
      });
      
      searchSpan.setOutcome('success');
    } catch (err) {
      apm.captureError(err);
      searchSpan.setOutcome('failure');
      throw err;
    } finally {
      searchSpan.end();
    }
    
    // Transform response
    const products = searchRes.hits.hits.map(hit => hit._source);
    
    // Set transaction outcome and end it
    transaction.setOutcome('success');
    transaction.end();
    
    res.json({ products });
  } catch (err) {
    // Capture error and log it
    apm.captureError(err);
    transaction.setOutcome('failure');
    transaction.end();
    
    logger.error(addTraceContext({
      message: 'Failed to list products',
      error: { message: err.message, stack: err.stack }
    }));
    
    res.status(500).json({ error: 'Failed to query products' });
  }
});

// Get a product by ID
app.get('/products/:id', async (req, res) => {
  const { id } = req.params;
  
  // Create transaction for getting a product by ID
  const transaction = apm.startTransaction('get_product_by_id', 'request');
  
  // Add product ID as a label
  transaction.addLabels({
    'product.id': id
  });
  
  try {
    logger.info(addTraceContext({
      message: `Getting product by ID: ${id}`,
      product: { id }
    }));
    
    // Create a span for getting the product from Elasticsearch
    const getSpan = createSpan('ES /catalog/_doc');
    
    let result;
    try {
      const getRes = await esClient.get({
        index: ES_INDEX,
        id
      });
      
      result = getRes;
      getSpan.setOutcome('success');
    } catch (err) {
      if (err.meta && err.meta.statusCode === 404) {
        result = null;
        getSpan.setOutcome('success'); // Not found is still a successful operation
      } else {
        apm.captureError(err);
        getSpan.setOutcome('failure');
        throw err;
      }
    } finally {
      getSpan.end();
    }
    
    if (!result) {
      logger.warn(addTraceContext({
        message: `Product with ID ${id} not found`,
        product: { id }
      }));
      
      transaction.setOutcome('success'); // Not found is a valid business outcome
      transaction.end();
      return res.status(404).json({ error: 'Product not found' });
    }
    
    const product = result._source;
    
    transaction.setOutcome('success');
    transaction.end();
    res.json(product);
  } catch (err) {
    apm.captureError(err);
    transaction.setOutcome('failure');
    transaction.end();
    
    logger.error(addTraceContext({
      message: `Failed to get product with ID ${id}`,
      product: { id },
      error: { message: err.message, stack: err.stack }
    }));
    
    res.status(500).json({ error: 'Failed to retrieve product' });
  }
});

// Start the server
async function startServer() {
  try {
    await setupElasticsearch();
    
    app.listen(PORT, () => {
      logger.info({
        message: `Catalog service started on port ${PORT}`,
        service: {
          name: SERVICE_NAME,
          version: SERVICE_VERSION
        }
      });
    });
    
    // Graceful shutdown
    const shutdown = () => {
      logger.info({ message: 'Shutting down catalog service' });
      process.exit(0);
    };
    
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    logger.error({
      message: 'Failed to start catalog service',
      error: { message: err.message, stack: err.stack }
    });
    process.exit(1);
  }
}

// Start the server
startServer();
