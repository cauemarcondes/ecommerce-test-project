.PHONY: up down status seed clean logs test

# Default target
all: up

# Start all services
up:
	@echo "Starting mini-shop-otel services..."
	docker compose up -d
	@echo "Services starting. View status with 'make status'"

# Stop all services and remove containers
down:
	@echo "Stopping mini-shop-otel services..."
	docker compose down
	@echo "Services stopped"

# View status of all services
status:
	docker compose ps

# Seed initial test data (if needed)
seed:
	@echo "No additional seeding needed - catalog service auto-seeds test data"

# Clean volumes and dangling images
clean:
	@echo "Removing containers, volumes, and networks..."
	docker compose down -v
	docker system prune -f
	@echo "Cleanup complete"

# View logs of all services or a specific service
logs:
	@if [ -z "$(service)" ]; then \
		docker compose logs -f; \
	else \
		docker compose logs -f $(service); \
	fi

# Test the API with a checkout request
test:
	@echo "Testing the system with a checkout request..."
	curl -X POST http://localhost:3000/checkout \
	  -H "Content-Type: application/json" \
	  -d '{"productId": "2", "quantity": 1, "customerEmail": "user@example.com"}'

# Help target
help:
	@echo "Mini-Shop OpenTelemetry System"
	@echo ""
	@echo "Available commands:"
	@echo "  make up          - Start all services"
	@echo "  make down        - Stop all services"
	@echo "  make status      - Check service status"
	@echo "  make logs        - View logs from all services"
	@echo "  make logs service=api-gateway - View logs from a specific service"
	@echo "  make test        - Send a test checkout request"
	@echo "  make clean       - Remove containers, volumes, and networks"
	@echo "  make help        - Show this help message"
	@echo ""
