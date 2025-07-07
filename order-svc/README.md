# Order Service

A Node.js Express service for processing orders with OpenTelemetry instrumentation, Elasticsearch storage, RabbitMQ messaging, and gRPC client for payment processing.

## Environment Variables

```
PORT=8081
OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4317
OTEL_SERVICE_NAME=order-svc
SERVICE_VERSION=0.1.0
ELASTICSEARCH_URL=http://localhost:9200
RABBITMQ_URL=amqp://localhost:5672
PAYMENT_SVC_URL=localhost:9000
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

### POST /order
Create a new order

Example:
```bash
curl -X POST http://localhost:8081/order \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "1",
    "productName": "Windsurf Laptop Pro",
    "quantity": 1,
    "amount": 1299.99,
    "customerEmail": "user@example.com"
  }'
```

### GET /order/:id
Retrieve a specific order by ID

Example:
```bash
curl -X GET http://localhost:8081/order/123e4567-e89b-12d3-a456-426614174000
```

### GET /health
Health check endpoint

Example:
```bash
curl -X GET http://localhost:8081/health
```
