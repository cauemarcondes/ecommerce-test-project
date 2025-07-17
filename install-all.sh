#!/bin/bash

# Script to install npm dependencies in all project services
echo "Installing npm dependencies for all services..."

# List of all service directories
SERVICES=(
  "api-gateway"
  "catalog-svc"
  "order-svc"
  "payment-svc"
  "email-worker"
)

# Get the script directory (project root)
ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Loop through each service and install dependencies
for service in "${SERVICES[@]}"; do
  echo ""
  echo "Installing dependencies for $service"
  echo "-----------------------------------"
  cd "$ROOT_DIR/$service" || { echo "Error: Could not navigate to $service directory"; exit 1; }
  
  # Run npm install
  npm install
  
  # Check if npm install was successful
  if [ $? -eq 0 ]; then
    echo "✅ Successfully installed dependencies for $service"
  else
    echo "❌ Failed to install dependencies for $service"
  fi
done

echo ""
echo "All dependencies installation complete!"
