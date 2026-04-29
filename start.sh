#!/bin/bash
# XRPL Meme Bot - Quick Start Script

set -e

echo "=== XRPL Meme Bot Setup ==="

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed"
    exit 1
fi

echo "Node.js version: $(node -v)"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Build if dist doesn't exist
if [ ! -d "dist" ]; then
    echo "Building TypeScript..."
    ./node_modules/.bin/tsc
fi

# Create directories
mkdir -p logs data

# Check .env exists
if [ ! -f ".env" ]; then
    echo "Creating .env from example..."
    cp .env.example .env
    echo "WARNING: Please edit .env with your Telegram credentials before running!"
fi

# Run the bot
echo ""
echo "Starting XRPL Meme Bot..."
echo "Press Ctrl+C to stop"
echo ""
node dist/index.js
