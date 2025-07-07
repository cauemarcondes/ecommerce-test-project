'use strict';

// Load OpenTelemetry instrumentation first
require('./instrumentation');

const express = require('express');
const { Client } = require('@elastic/elasticsearch');
const { trace, context, SpanStatusCode } = require('@opentelemetry/api');
const pino = require('pino');
const pinoHttp = require('pino-http');

// Environment variables
const PORT = process.env.PORT || 8080;
const ELASTICSEARCH_URL = process.env.ELASTICSEARCH_URL || 'http://elasticsearch:9200';
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'catalog-svc';
const SERVICE_VERSION = process.env.SERVICE_VERSION || '0.1.0';
const ES_INDEX = 'catalog';

// Initialize tracer
const tracer = trace.getTracer('catalog-svc-tracer');

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
      dataset: 'catalog.log'
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
    const span = trace.getSpan(context.active());
    if (span) {
      const spanContext = span.spanContext();
      return {
        trace: { id: spanContext.traceId },
        span: { id: spanContext.spanId }
      };
    }
    return {};
  }
}));

// Check Elasticsearch connectivity and create index/seed data if needed
async function setupElasticsearch() {
  return tracer.startActiveSpan('setup_elasticsearch', async (span) => {
    try {
      logger.info(addTraceContext(span, {
        message: 'Checking Elasticsearch connectivity'
      }));
      
      // Check if Elasticsearch is up
      const healthRes = await esClient.cluster.health();
      if (healthRes.status === 'red') {
        throw new Error('Elasticsearch cluster is in red status');
      }
      
      logger.info(addTraceContext(span, {
        message: 'Elasticsearch is healthy',
        cluster: { status: healthRes.status }
      }));
      
      // Check if catalog index exists
      const indexExists = await tracer.startActiveSpan('ES /_cat/indices', async (indexSpan) => {
        try {
          const res = await esClient.indices.exists({ index: ES_INDEX });
          return res;
        } catch (err) {
          indexSpan.recordException(err);
          indexSpan.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          indexSpan.end();
        }
      });
      
      // Create index if it doesn't exist
      if (!indexExists) {
        await tracer.startActiveSpan('ES /catalog', async (createSpan) => {
          try {
            logger.info(addTraceContext(createSpan, {
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
            
            logger.info(addTraceContext(createSpan, {
              message: `${ES_INDEX} index created`
            }));
            
            // Seed sample data
            await seedSampleData();
          } catch (err) {
            createSpan.recordException(err);
            createSpan.setStatus({ code: SpanStatusCode.ERROR });
            throw err;
          } finally {
            createSpan.end();
          }
        });
      } else {
        logger.info(addTraceContext(span, {
          message: `${ES_INDEX} index already exists`
        }));
        
        // Check if we need to seed data
        const countRes = await esClient.count({ index: ES_INDEX });
        if (countRes.count === 0) {
          await seedSampleData();
        } else {
          logger.info(addTraceContext(span, {
            message: `${ES_INDEX} index already contains ${countRes.count} products`
          }));
        }
      }
      
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
      logger.error(addTraceContext(span, {
        message: 'Failed to setup Elasticsearch',
        error: { message: err.message, stack: err.stack }
      }));
      throw err;
    } finally {
      span.end();
    }
  });
}

// Seed sample product data
async function seedSampleData() {
  return tracer.startActiveSpan('seed_sample_data', async (span) => {
    try {
      logger.info(addTraceContext(span, {
        message: `Seeding ${sampleProducts.length} sample products`
      }));
      
      const bulkBody = [];
      sampleProducts.forEach(product => {
        bulkBody.push(
          { index: { _index: ES_INDEX, _id: product.id } },
          product
        );
      });
      
      await tracer.startActiveSpan('ES /catalog/_bulk', async (bulkSpan) => {
        try {
          const res = await esClient.bulk({
            body: bulkBody,
            refresh: true
          });
          
          if (res.errors) {
            throw new Error(`Bulk indexing had errors: ${JSON.stringify(res.errors)}`);
          }
          
          logger.info(addTraceContext(bulkSpan, {
            message: `Successfully seeded ${sampleProducts.length} products`
          }));
        } catch (err) {
          bulkSpan.recordException(err);
          bulkSpan.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          bulkSpan.end();
        }
      });
      
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
      logger.error(addTraceContext(span, {
        message: 'Failed to seed sample data',
        error: { message: err.message, stack: err.stack }
      }));
      throw err;
    } finally {
      span.end();
    }
  });
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
  await tracer.startActiveSpan('list_products', async (span) => {
    try {
      logger.info(addTraceContext(span, {
        message: 'Listing all products'
      }));
      
      const result = await tracer.startActiveSpan('ES /catalog/_search', async (searchSpan) => {
        try {
          // Prepare search query
          const query = {
            query: { match_all: {} },
            size: 100
          };
          
          // Perform search
          const searchRes = await esClient.search({
            index: ES_INDEX,
            body: query
          });
          
          return searchRes;
        } catch (err) {
          searchSpan.recordException(err);
          searchSpan.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          searchSpan.end();
        }
      });
      
      // Transform response
      const products = result.hits.hits.map(hit => hit._source);
      
      span.setStatus({ code: SpanStatusCode.OK });
      res.json({ products });
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
      logger.error(addTraceContext(span, {
        message: 'Failed to list products',
        error: { message: err.message, stack: err.stack }
      }));
      res.status(500).json({ error: 'Failed to query products' });
    } finally {
      span.end();
    }
  });
});

// Get a product by ID
app.get('/products/:id', async (req, res) => {
  const { id } = req.params;
  
  await tracer.startActiveSpan('get_product_by_id', async (span) => {
    try {
      span.setAttribute('product.id', id);
      logger.info(addTraceContext(span, {
        message: `Getting product by ID: ${id}`,
        product: { id }
      }));
      
      const result = await tracer.startActiveSpan('ES /catalog/_doc', async (getSpan) => {
        try {
          getSpan.setAttribute('product.id', id);
          
          const getRes = await esClient.get({
            index: ES_INDEX,
            id
          });
          
          return getRes;
        } catch (err) {
          if (err.meta && err.meta.statusCode === 404) {
            return null;
          }
          getSpan.recordException(err);
          getSpan.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          getSpan.end();
        }
      });
      
      if (!result) {
        logger.warn(addTraceContext(span, {
          message: `Product with ID ${id} not found`,
          product: { id }
        }));
        return res.status(404).json({ error: 'Product not found' });
      }
      
      span.setStatus({ code: SpanStatusCode.OK });
      res.json(result._source);
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
      logger.error(addTraceContext(span, {
        message: `Failed to get product with ID ${id}`,
        product: { id },
        error: { message: err.message, stack: err.stack }
      }));
      res.status(500).json({ error: 'Failed to retrieve product' });
    } finally {
      span.end();
    }
  });
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
