# Catalog Service

A Node.js Express-based service for providing product catalog information with OpenTelemetry instrumentation.

## Environment Variables

```
PORT=8080
OTEL_EXPORTER_OTLP_ENDPOINT=localhost:4317
OTEL_SERVICE_NAME=catalog-svc
SERVICE_VERSION=0.1.0
ELASTICSEARCH_URL=http://localhost:9200
NODE_ENV=development
LOG_LEVEL=info
```

## Local Development

```bash
# Install dependencies
npm install

# Run the service
node src/index.js
```

## API Endpoints

### GET /products
Retrieve all products from the catalog

Example:
```bash
curl -X GET http://localhost:8080/products
```

### GET /product/:id
Retrieve a specific product by ID

Example:
```bash
curl -X GET http://localhost:8080/product/1
```

### GET /health
Health check endpoint

Example:
```bash
curl -X GET http://localhost:8080/health
```
