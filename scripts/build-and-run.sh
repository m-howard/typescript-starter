#!/bin/bash

# Build and run the TypeScript application

set -e

echo "🔨 Building TypeScript application..."
npm run build

echo "🚀 Running application..."
npm run start:prod
