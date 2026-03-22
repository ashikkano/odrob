# ODROB: Autonomous Trading Platform

ODROB is an open-source platform for building, testing, and launching autonomous trading strategies and index products. It features a strategy marketplace, transparent analytics, and seamless integration with Tether WDK Wallet for secure USDT onboarding and management.

## Features
- Create, test, and publish trading strategies
- On-chain index and asset management
- Public and private indexes
- Automatic dividend payouts
- Transparent analytics and dashboards
- Secure onboarding with Tether WDK Wallet
- Modern, responsive web interface

## Technology Stack
- **Frontend:** React, Vite, CSS Modules
- **Backend:** Node.js, Express
- **Database:** SQLite (for demo/dev), can be extended
- **Wallet Integration:** Tether WDK Wallet

## Quick Start

### 1. Clone the repository
```sh
git clone https://github.com/your-org/odrob.git
cd odrob
```

### 2. Install dependencies
```sh
npm install
cd server && npm install && cd ..
```

### 3. Configure Environment
Copy `.env.example` to `.env.local` and set the required variables:
```sh
cp .env.example .env.local
```

#### Example `.env.local` for WDK Wallet:
```
# Tether WDK Wallet settings
PRIVY_ENABLED=true
PRIVY_APP_ID=your-privy-app-id
PRIVY_APP_SECRET=your-privy-app-secret
PRIVY_AUTO_PROVISION_WDK_WALLET=true
WDK_MASTER_SEED=your-master-seed
```

### 4. Run the development server
```sh
npm run dev
```

The app will be available at [http://localhost:3000](http://localhost:3000)

#### To enable WDK Wallet:
1. Register your app with Tether WDK to obtain a `PRIVY_APP_ID` and `PRIVY_APP_SECRET`.
2. Set `PRIVY_AUTO_PROVISION_WDK_WALLET=true` and `WDK_MASTER_SEED` in your `.env.local`.
3. The frontend will automatically detect and offer WDK Wallet as an option.

## Scripts
- `npm run dev` — Start development server
- `npm run build` — Build for production
- `npm run start` — Start production server

## Contributing
Pull requests and issues are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License
MIT License. See [LICENSE](LICENSE) for details.

### 1. Agent Trading Engine

- User and system agents
- Execution decisions and trade history
- Holdings, virtual balances, equity curves, and telemetry
- Runtime pause/start/recovery hooks for operations

### 2. Index & Treasury System

- System and agent-created indexes
- Oracle snapshots and price bands
- Treasury redistribution and backing logic
- Global fee pool and reserve mechanics
- Market-maker defaults and per-index overrides

### 3. Strategy Marketplace

- Publish custom strategies and versions
- Install marketplace strategies on compatible agents
- Rotation defaults and runtime behavior metadata
- Creator fee / royalty tracking
- Execution trace visibility for installed strategies

### 4. LLM Strategy Module

- Direct LLM strategy installs
- Public shared-scope LLM installs
- Shared creator memory and state
- Strategy-managed subscription scope for public/shared LLM templates
- Smoke tests for shared-scope and marketplace pipelines

### 5. Admin v2 Operations Surface

- Overview / control center
- Markets / providers / treasury / risk / diagnostics / audit
- Runtime controls and system parameter patching
- Structured audit details and guarded admin access flows

## Repository Layout

```text
.
├── src/                 Frontend app, pages, components, contexts, services
├── server/              Express backend, engine runtime, routes, services, DB, migrations
├── scripts/             Verification, smoke, and helper scripts
├── docs/                Architecture, migration, parity, and system docs
├── public/              Static assets
├── Dockerfile.backend   Backend container image
├── Dockerfile.frontend  Frontend container image
├── docker-compose.yml   Local/hosted multi-service orchestration
└── README.md            This file
```

## Tech Stack

### Frontend

- React 19
- Vite 7
- React Router
- Radix UI primitives
- Recharts
- TON Connect UI

### Backend

- Node.js (ES modules)
- Express
- better-sqlite3
- Zod
- Helmet / CORS / rate limiting

### Infrastructure

- SQLite for local/runtime persistence
- Docker + Docker Compose
- GitHub Actions workflow in [.github/workflows/ci.yml](.github/workflows/ci.yml)

## Local Development

### Prerequisites

- Node.js 20+ recommended
- npm
- macOS/Linux shell environment
- Optional: Docker / Docker Compose

### Install Dependencies

Install both the frontend/root dependencies and the backend dependencies:

```bash
npm install
cd server && npm install && cd ..
```

### Start the Platform

#### Standard local development

Runs backend on `3001` and frontend on `3000` through the dev runner:

```bash
npm run dev
```

#### Fresh local database

Deletes the local SQLite database before starting:

```bash
npm run dev:fresh
```

#### Backend only

```bash
npm run start:api
```

#### Frontend only

```bash
npm run start:ui
```

#### Direct backend start

```bash
npm run server
```

### Default Local URLs

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:3001`
- API base: `http://localhost:3001/api`

### Database Notes

- Local runtime data lives under `server/data/`
- Runtime data is intentionally ignored by git
- `npm run dev:fresh` or `npm run server:fresh` resets the main local SQLite database
- Docker persists DB data through the `odrob-data` volume

## Quality Checks & Verification

### Lint and typecheck

```bash
npm run lint
npm run typecheck
```

### Main automated checks

```bash
npm test
```

This runs:

- fee accounting verification
- orderbook test
- LLM module test

## Docker Usage

Build and run the full platform with Docker Compose:

```bash
docker compose up -d --build
```

Useful commands:

```bash
docker compose logs -f backend
docker compose logs -f frontend
docker compose down
docker compose down -v
```

Fresh Docker DB reset:

```bash
docker compose down -v && docker compose up -d --build
```

## Operational Notes

### Wallet / auth model

- End-user flows rely on wallet-linked auth and wallet-bound agent ownership
- Strategy marketplace install actions use wallet-authenticated backend endpoints
- Admin-v2 uses guarded admin access and audit-aware operator identity

### LLM strategy behavior

- Direct LLM installs run with direct strategy ownership on the target agent
- Public/shared LLM marketplace templates can use shared creator execution and shared subscription scope
- Shared-scope subscription changes are strategy-managed rather than manual

### Runtime data and secrets

- Do not commit local `server/data` runtime files
- Do not commit `.env` files or private keys
- This repository intentionally ignores dependency folders, local DB files, and generated local artifacts

### Root scripts

- `npm run dev` — start backend + frontend via dev runner
- `npm run dev:fresh` — start with fresh DB
- `npm run start:api` — backend only
- `npm run start:ui` — frontend only
- `npm run server` — direct backend start
- `npm run server:fresh` — delete DB and start backend
- `npm run lint` — ESLint
- `npm run typecheck` — TypeScript project typecheck config
- `npm run build` — Vite production build
- `npm run preview` — preview built frontend
- `npm run docs:generate` — docs generation helper

## Status

This is an actively evolving private platform repository. It contains both product surfaces and deep operational/runtime tooling, so expect frequent schema, engine, and admin-surface changes.

