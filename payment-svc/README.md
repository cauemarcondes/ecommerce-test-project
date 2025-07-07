# Payment Service

A Node.js-based gRPC service that handles payment processing with OpenTelemetry instrumentation, including manual span creation and retry logic with span links.

## Environment Variables

```
PORT=9000
OTEL_EXPORTER_OTLP_ENDPOINT=localhost:4317
OTEL_SERVICE_NAME=payment-svc
SERVICE_VERSION=0.1.0
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

## gRPC Interface

The service implements the `Payment` service defined in the proto file with a single RPC method:

```
rpc Charge (ChargeRequest) returns (ChargeResponse)
```

You can test the gRPC endpoint using grpcurl:

```bash
# List services
grpcurl -plaintext localhost:9000 list

# Call the Charge RPC method
grpcurl -plaintext -d '{"order_id": "123", "amount": 99.99, "currency": "USD"}' localhost:9000 payment.Payment/Charge
```
