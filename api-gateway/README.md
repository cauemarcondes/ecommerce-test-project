# API Gateway Service

A Node.js Express service that acts as an entry point to the mini-shop-otel microservices system.

## Environment Variables

```
PORT=3000
OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4317
OTEL_SERVICE_NAME=api-gateway
SERVICE_VERSION=0.1.0
CATALOG_SVC_URL=http://localhost:8080
ORDER_SVC_URL=http://localhost:8081
NODE_ENV=production
LOG_LEVEL=info
```

## Local Development

```bash
# Install dependencies
npm install

# Start the service
npm start

# Start with hot-reload for development
npm run dev
```

## API Endpoints

### GET /products
Retrieve all products from the catalog service

Example:
```bash
curl -X GET http://localhost:3000/products
```

### GET /products/:id
Retrieve a specific product by ID

Example:
```bash
curl -X GET http://localhost:3000/products/1
```

### POST /checkout
Create an order with payment processing

Example:
```bash
curl -X POST http://localhost:3000/checkout \
  -H "Content-Type: application/json" \
  -d '{"productId": "1", "quantity": 2, "customerEmail": "user@example.com"}'
```

### GET /health
Health check endpoint

Example:
```bash
curl -X GET http://localhost:3000/health
```
