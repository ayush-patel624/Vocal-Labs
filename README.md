# FlowForge — AI Agent Workflow Builder

A full-stack mini n8n purpose-built for chaining AI agent steps, with multi-org isolation, two-layer permissions, and real-time execution monitoring.

![Tech Stack](https://img.shields.io/badge/PostgreSQL-15-blue) ![](https://img.shields.io/badge/Hasura-v2.38-purple) ![](https://img.shields.io/badge/Next.js-14-black) ![](https://img.shields.io/badge/Node.js-20-green)

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Next.js   │────▶│  Hasura GraphQL   │────▶│   PostgreSQL    │
│  Frontend   │     │     Engine        │     │   Database      │
│  (port 3000)│     │   (port 8080)     │     │  (port 5432)    │
└─────────────┘     └──────────────────┘     └─────────────────┘
                           │
                    ┌──────┴──────┐
                    │   Action    │
                    │   Handler   │──── Groq/Gemini LLM API
                    │ (port 3001) │
                    └─────────────┘
```

## Prerequisites

- **Docker Desktop** (with Docker Compose)
- **Node.js 18+** and npm
- **Groq API Key** (free tier) — or uses stub fallback

## Quick Start

### 1. Clone & Configure

```bash
cd VocalLab

# Copy and edit environment variables (already configured with Groq key)
cp .env.example .env
# Edit .env to add your LLM API key if not already set
```

### 2. Start Backend Services

```bash
# Start PostgreSQL + Hasura + Action Handler
docker-compose up -d --build

# Wait for services to be healthy (~30 seconds)
docker-compose ps
```

### 3. Apply Hasura Metadata

```bash
# Install axios dependency for setup script
cd hasura && npm install axios && node setup.js
cd ..
```

### 4. Start Frontend

```bash
cd frontend
npm install
npm run dev
```

### 5. Open the App

Navigate to **http://localhost:3000**

## Demo Accounts

All passwords: `password123`

| Email | Name | Organization | Role |
|-------|------|-------------|------|
| alice@orga.com | Alice | Alpha Corp | **Owner** |
| bob@orga.com | Bob | Alpha Corp | **Editor** |
| charlie@orga.com | Charlie | Alpha Corp | **Viewer** |
| dave@orgb.com | Dave | Beta Inc | **Owner** |
| eve@orgb.com | Eve | Beta Inc | **Editor** |

## Step Types

| Type | Icon | Description |
|------|------|-------------|
| `llm_call` | 🤖 | Calls Groq/Gemini LLM API with configurable prompt |
| `http_request` | 🌐 | Makes HTTP requests to external APIs |
| `db_write` | 💾 | Saves results to database (owner only) |
| `notify` | 🔔 | Sends notifications (owner only) |
| `conditional_branch` | 🔀 | If/else logic based on previous step output |
| `approval_gate` | ✋ | Pauses run until owner/editor approves |

## Trigger Types

| Type | Description |
|------|-------------|
| Manual | User clicks "Run Workflow" button |
| Webhook | POST to `http://localhost:3001/webhook/{workflow_id}` |
| Scheduled | Time-based via backend scheduler (runs on IST) |
| DB Event | Triggers when a DB table receives INSERT/UPDATE/DELETE |

### How to use Scheduled Triggers
When adding a **Scheduled** trigger to a workflow, follow these exact steps:
1. Click **+** on the Triggers box and add a "Scheduled" trigger.
2. Enter the exact time you want the workflow to run in the **Time (IST)** field (e.g., `14:30`). *Note: The scheduler runs strictly on Indian Standard Time (IST).*
3. **CRITICAL:** You **must** click the **"Save Workflow"** button at the top right of the screen to commit your new time to the database. If you do not save, the backend scheduler will not know about your change.
4. The background scheduler checks the database every 10 seconds. Once the exact minute hits, it will automatically spawn a workflow run!

## Testing Webhook Trigger

```bash
curl -X POST http://localhost:3001/webhook/w1000000-0000-0000-0000-000000000001 \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: whsec_alpha_pipeline_key" \
  -d '{"test": true}'
```

## Two-Layer Permission System

### Layer 1: Hasura Row-Level Permissions (Org + Role Scoping)
- Every query filters through `org_members` relationship
- An editor in Org A **cannot** see Org B's data, even by guessing IDs
- Viewer role: read-only, no run triggering

### Layer 2: Action Handler Runtime Checks
- `db_write` and `notify` steps: only owners can add
- `webhook` and `database_event` triggers: only owners can add
- `approval_gate`: handler verifies approver's org role at runtime
- Quota enforcement before every run

## Final Demo Scenario

1. ✅ Two orgs exist (Alpha Corp, Beta Inc) with different users/roles
2. ✅ Org A owner builds workflow: LLM Call → Conditional Branch → HTTP Request → Approval Gate → DB Write
3. ✅ Trigger manually (button) and via webhook (curl)
4. ✅ Approval gate pauses run; owner/editor approves
5. ✅ Live status streaming (polling-based subscription)
6. ✅ Cross-org isolation: Org B user cannot access Org A data

## Project Structure

```
VocalLab/
├── docker-compose.yml          # Infrastructure orchestration
├── .env                        # Environment configuration
├── hasura/
│   ├── migrations/1_init/
│   │   └── up.sql              # Database schema + seed data
│   └── setup.js                # Hasura metadata setup script
├── action-handler/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js            # Express server + all routes
│       ├── executor.js         # Workflow step execution engine
│       └── llm.js              # LLM API client (Groq/Gemini/stub)
├── frontend/
│   ├── package.json
│   ├── next.config.js
│   ├── .env.local
│   ├── lib/
│   │   └── auth.js             # Auth context + JWT management
│   └── app/
│       ├── layout.js
│       ├── globals.css         # Premium dark theme
│       ├── page.js
│       ├── login/page.js
│       ├── dashboard/page.js
│       └── workflows/[id]/page.js
├── README.md
└── WRITEUP.md
```

## Stopping Services

```bash
docker-compose down        # Stop containers
docker-compose down -v     # Stop + remove volumes (fresh start)
```
