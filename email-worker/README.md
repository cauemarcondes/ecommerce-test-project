# Email Worker

A Node.js-based worker service that consumes order confirmation messages from RabbitMQ, retrieves order details from Elasticsearch, and simulates sending confirmation emails.

## Environment Variables

```
OTEL_EXPORTER_OTLP_ENDPOINT=localhost:4317
OTEL_SERVICE_NAME=email-worker
SERVICE_VERSION=0.1.0
ELASTICSEARCH_URL=http://localhost:9200
RABBITMQ_URL=amqp://guest:guest@localhost:5672/
NODE_ENV=development
LOG_LEVEL=info
```

## Local Development

```bash
# Install dependencies
npm install

# Run the worker
node src/index.js
```

## Message Format

The service consumes messages from the `order.confirmed` queue, which should contain JSON payloads with at least the order ID:

```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000"
}
```

It then retrieves the full order details from Elasticsearch and simulates sending a confirmation email.
