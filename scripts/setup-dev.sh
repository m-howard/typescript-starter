#!/bin/bash

# Development setup script

set -e

echo "🔧 Setting up development environment..."

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Run linting
echo "🔍 Running linter..."
npm run lint

# Run tests
echo "🧪 Running tests..."
npm run test

# Run build
echo "🔨 Building project..."
npm run build

echo "✅ Development environment setup complete!"
echo "🚀 You can now run 'npm run start:dev' to start the development server"
