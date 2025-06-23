#!/bin/bash

# Clean build artifacts and dependencies

set -e

echo "🧹 Cleaning build artifacts..."

# Remove build output
if [ -d "bin" ]; then
    rm -rf bin
    echo "✅ Removed bin directory"
fi

if [ -d "dist" ]; then
    rm -rf dist
    echo "✅ Removed dist directory"
fi

# Remove coverage reports
if [ -d "coverage" ]; then
    rm -rf coverage
    echo "✅ Removed coverage directory"
fi

if [ -d "coverage-e2e" ]; then
    rm -rf coverage-e2e
    echo "✅ Removed coverage-e2e directory"
fi

# Remove node_modules if requested
if [ "$1" = "--all" ] || [ "$1" = "-a" ]; then
    if [ -d "node_modules" ]; then
        rm -rf node_modules
        echo "✅ Removed node_modules directory"
    fi
    
    if [ -f "package-lock.json" ]; then
        rm package-lock.json
        echo "✅ Removed package-lock.json"
    fi
fi

echo "🎉 Cleanup complete!"

if [ "$1" = "--all" ] || [ "$1" = "-a" ]; then
    echo "💡 Run 'npm install' to reinstall dependencies"
fi
