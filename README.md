<h1 align="center">TypeScript Starter</h1>

<p align="center">
  <em>A complete, production-ready TypeScript starter template</em>
  <br>
  <em>Perfect foundation for your next TypeScript project with modern tooling and best practices</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7.3-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Jest-29.7.0-red?style=flat-square&logo=jest" alt="Jest">
  <img src="https://img.shields.io/badge/ESLint-9.18.0-purple?style=flat-square&logo=eslint" alt="ESLint">
  <img src="https://img.shields.io/badge/Prettier-3.4.2-yellow?style=flat-square&logo=prettier" alt="Prettier">
</p>

## ✨ Features

- 🚀 **Modern TypeScript** - Latest TypeScript with strict type checking
- 🧪 **Comprehensive Testing** - Jest with unit, integration, and e2e tests
- 📝 **Code Quality** - ESLint + Prettier for consistent code style
- 🔧 **Development Tools** - Hot reload, debugging, and build scripts
- 📚 **Documentation** - Complete API docs and examples
- 🏗️ **Project Structure** - Well-organized, scalable architecture
- ⚡ **Fast Development** - Quick setup with helpful scripts

## 🚀 Quick Start

```bash
# Clone the repository
git clone <your-repo-url>
cd typescript-starter

# Install dependencies and set up development environment
npm install
npm run setup

# Start development
npm run start:dev
```

## 📁 Project Structure

```
src/
├── index.ts           # Main application entry point
├── main.ts            # Library exports
├── models/            # Data models and entities
├── services/          # Business logic and services
├── utils/             # Utility functions and helpers
└── maintenance/       # Runner-fleet maintenance scan (see below)

infra/                 # Inventory of what is deployed - read by the scan
schemas/               # Published JSON Schema, generated from src/maintenance
test/                  # Comprehensive test suite
scripts/               # Development and build scripts
docs/                  # Documentation
maintenance.config.yaml  # Everything the scan reads, declared explicitly
```

## 🛠️ Available Scripts

| Script                        | Description                                  |
| ----------------------------- | -------------------------------------------- |
| `npm start`                   | Run the application                          |
| `npm run start:dev`           | Development mode with hot reload             |
| `npm run build`               | Build for production                         |
| `npm run test`                | Run all tests                                |
| `npm run test:cov`            | Run tests with coverage                      |
| `npm run lint`                | Check code quality                           |
| `npm run format`              | Format code                                  |
| `npm run clean`               | Clean build artifacts                        |
| `npm run maintenance:collect` | Scan for version drift and write a report    |
| `npm run schema:check`        | Regenerate the JSON Schema and fail on drift |

## 📖 Documentation

- [Complete Documentation](./docs/README.md) - Comprehensive project guide
- [API Reference](./docs/API.md) - Detailed API documentation
- [Maintenance automation](./docs/maintenance/README.md) - The runner-fleet scan

## 🔍 Maintenance scan

`src/maintenance/` keeps a GitHub Actions self-hosted runner fleet on ARC and
EKS from drifting. It checks five surfaces — npm packages, action references,
ARC charts, the EKS cluster and its addons, and container images with the tools
baked into them — against what each publishes upstream, and writes a strict JSON
report.

The split is the design: deterministic tools establish **what is**, and every
finding carries the file, line and command it came from. Judgement — what an
upgrade breaks, how risky it is, what verifies it — belongs to a later
agent-driven stage, and the schema makes that boundary a parse error rather than
a convention.

```bash
npm run maintenance:collect            # writes .maintenance/report.json
npm run maintenance:collect -- --offline   # no network; nothing resolved upstream
```

It exits zero however many findings it produces; a non-zero exit means the tool
broke. Everything it reads is declared in `maintenance.config.yaml` — there is no
globbing, so what gets scanned is visible in one reviewable file. A scheduled
workflow runs it weekly and uploads the report.

## 🧪 Example Usage

The starter includes example implementations:

```typescript
import { User, Calculator, Logger } from './src/main';

// Create and use a user model
const user = new User('John Doe', 'john@example.com', 25);
console.log(user.getDisplayName()); // "John Doe (25)"

// Use the calculator service
const calc = new Calculator();
console.log(calc.add(5, 3)); // 8

// Use the logger utility
const logger = new Logger();
logger.info('Application started');
```

## 🎯 What's Included

### Core Components

- **User Model** - Demonstrates TypeScript classes with validation
- **Calculator Service** - Shows service architecture patterns
- **Logger Utility** - Provides structured logging
- **Helper Functions** - Common utility functions

### Development Setup

- **TypeScript Configuration** - Optimized for modern development
- **Jest Testing** - Unit, integration, and e2e test examples
- **ESLint Rules** - Enforces code quality standards
- **Prettier Config** - Consistent code formatting
- **Build Scripts** - Automated development workflows

## 🔧 Customization

This starter is designed to be easily customizable:

1. **Models** - Replace example User model with your domain models
2. **Services** - Add your business logic services
3. **Utils** - Extend or replace utility functions
4. **Tests** - Follow the testing patterns for your code
5. **Scripts** - Modify development workflows as needed

## 📄 License

UNLICENSED - Free to use for any purpose

---

<p align="center">
  <em>Happy coding! 🎉</em>
</p>
