# Mini-Shop OpenTelemetry Demonstration

A polyglot micro-service system designed to experiment with OpenTelemetry instrumentation, tail sampling, and Elastic APM ingestion. The system is composed of five microservices written in Node.js and Go, with all state stored in Elasticsearch and message passing via RabbitMQ.

## System Architecture

![Architecture Diagram]

### Microservices

1. **api-gateway** (Node.js Express)
   - Entry point for client requests
   - Exposes REST endpoints `/products`, `/checkout`
   - Injects W3C trace-context headers downstream
   - Adds custom baggage item `release=<git-sha>`

2. **catalog-svc** (Go Fiber)
   - Product catalog service
   - Provides `/product/{id}` endpoint to fetch products from Elasticsearch
   - Auto-instrumented with OTel Go SDK

3. **order-svc** (Node.js Express)
   - Order processing service
   - Creates orders in Elasticsearch
   - Publishes order confirmed events to RabbitMQ
   - Uses gRPC to communicate with payment-svc

4. **payment-svc** (Go gRPC)
   - Payment processing service
   - Provides `Charge` RPC method
   - Demonstrates manual span creation and retry logic with span links

5. **email-worker** (Go)
   - Consumes order confirmation messages from RabbitMQ
   - Retrieves order information from Elasticsearch
   - Simulates sending confirmation emails

### Infrastructure

- **Elasticsearch 8.13**: Single node with security disabled for storing product catalog, orders, and traces
- **OpenTelemetry Collector**: Collects telemetry data, performs tail-sampling, and exports to both raw Elasticsearch and Elastic APM
- **RabbitMQ 3.13**: Message broker for asynchronous communication between services

## Prerequisites

- Docker and Docker Compose
- Make (optional, for using the provided Makefile)
- cURL (for testing the API endpoints)

## Quick Start

### Start the System

```bash
# Clone the repository
git clone <repository-url>
cd mini-shop-otel

# Start all services
make up
# Or without Make: docker-compose up -d
```

### Test the System

```bash
# Wait for all services to start (about 30-60 seconds)
make status
# Or: docker-compose ps

# Create an order
curl -X POST http://localhost:3000/checkout \
  -H "Content-Type: application/json" \
  -d '{"productId": "1", "quantity": 2, "customerEmail": "user@example.com"}'
```

### View Traces

1. Open Kibana at http://localhost:5601
2. Navigate to Observability > APM > Services
3. Explore the services, transactions, and trace details

### Shutdown

```bash
make down
# Or: docker-compose down
```

## Observability Features

- **Auto-instrumentation** for HTTP, gRPC, and RabbitMQ where supported by SDKs
- **Manual spans** around Elasticsearch queries with appropriate naming (`span.name = "ES /<index>/_search"`)
- **Service versions** attached as attributes
- **Structured JSON logs** in ECS format with trace.id and span.id included
- **Tail sampling** keeping all error traces + 10% of normal traces

## Development

Each service directory contains its own README with specific instructions for local development and testing.

### Common Environment Variables

- `OTEL_EXPORTER_OTLP_ENDPOINT`: OpenTelemetry collector endpoint (default: http://host.docker.internal:4317)
- `OTEL_SERVICE_NAME`: Service name for telemetry data
- `SERVICE_VERSION`: Version of the service
- `ELASTICSEARCH_URL`: Elasticsearch endpoint (default: http://localhost:9200)
- `RABBITMQ_URL`: RabbitMQ connection string (default: amqp://localhost:5672)

## Project Structure

```
mini-shop-otel/
├── docker-compose.yml             # Docker Compose configuration
├── otel-collector-config.yaml     # OpenTelemetry Collector configuration
├── api-gateway/                   # Node.js Express API Gateway
├── catalog-svc/                   # Go Fiber Catalog Service
├── order-svc/                     # Node.js Express Order Service
├── payment-svc/                   # Go gRPC Payment Service
└── email-worker/                  # Go Email Worker
```
