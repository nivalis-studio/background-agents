# Open-Inspect Discord Bot

A Cloudflare Worker that integrates Discord with Open-Inspect. It exposes Discord interactions,
creates coding sessions through the control plane, and posts completion updates back into Discord.

The Discord bot currently provides two user-facing flows:

1. **`/inspect`** - start a coding session from a slash command
2. **`/inspect-settings`** - store your preferred model and reasoning effort

When `/inspect` runs inside an existing Discord thread that already has a mapped Open-Inspect
session, the bot sends a follow-up prompt to that session instead of creating a new one.

## How It Works

```
/inspect in Discord -> Discord sends interaction webhook ->
  Bot verifies signature -> Resolves repo -> Creates session ->
  Posts working status in Discord thread -> Agent runs in sandbox ->
  Completion callback -> Bot posts final summary with links
```

1. A user runs `/inspect prompt:<...> repo:<optional owner/name>`
2. Discord sends an interaction webhook to `/interactions`
3. The worker verifies the Ed25519 signature with the Discord application public key
4. The worker resolves the target repo:
   - explicit `repo` option
   - channel association / thread context
   - LLM classifier fallback
5. The worker creates an Open-Inspect session and sends the prompt via the control plane
6. The worker posts a status message and adds a thinking reaction in Discord
7. The control plane calls `/callbacks/complete` when the agent finishes
8. The worker fetches the session output and posts a completion message with artifacts and a session
   link

## Key Behavior

- **Thread continuity** - Discord thread channel IDs are mapped to Open-Inspect session IDs in KV
- **Repo clarification** - when repo resolution is uncertain, the bot replies with a Discord select
  menu so the user can choose the target repo
- **Per-user preferences** - model and reasoning effort are stored in KV and configured through
  `/inspect-settings`
- **Completion callbacks** - results are posted asynchronously after the agent finishes, rather than
  keeping the interaction request open

## Deployment

The bot is deployed via Terraform as a standalone Cloudflare Worker.

### Two-phase deployment

Use the same deployment pattern as the other workers:

1. Deploy with `enable_service_bindings = false`
2. Set `enable_service_bindings = true` and apply again

### Terraform variables

Enable the worker and provide Discord credentials in `terraform.tfvars`:

```hcl
enable_discord_bot     = true
discord_application_id = "your-application-id"
discord_public_key     = "your-public-key"
discord_bot_token      = "your-bot-token"
```

The worker also uses these existing values:

- `anthropic_api_key`
- `internal_callback_secret`
- `deployment_name`

### Worker bindings

| Binding                    | Type            | Description                                            |
| -------------------------- | --------------- | ------------------------------------------------------ |
| `DISCORD_KV`               | KV namespace    | Thread/session mappings, pending clarifications, prefs |
| `CONTROL_PLANE`            | Service binding | Fetcher to the control plane worker                    |
| `CONTROL_PLANE_URL`        | Plain text      | Control plane URL for logging and fallback             |
| `WEB_APP_URL`              | Plain text      | Web app base URL for session links                     |
| `DEFAULT_MODEL`            | Plain text      | Default model for new sessions                         |
| `CLASSIFICATION_MODEL`     | Plain text      | Model used for repo classification                     |
| `DISCORD_APPLICATION_ID`   | Plain text      | Discord app ID                                         |
| `DISCORD_PUBLIC_KEY`       | Secret          | Discord interaction verification key                   |
| `DISCORD_BOT_TOKEN`        | Secret          | Discord bot token                                      |
| `ANTHROPIC_API_KEY`        | Secret          | LLM classifier key                                     |
| `INTERNAL_CALLBACK_SECRET` | Secret          | HMAC auth for control-plane callbacks                  |

## Discord Setup

### 1. Create the application

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create a new application
2. Under **Bot**, create a bot user and copy the bot token
3. Under **General Information**, copy the application ID and public key
4. Invite the bot to your server with these scopes:
   - `bot`
   - `applications.commands`

### 2. Configure the interactions endpoint

After Terraform deploys the worker, set:

```text
https://open-inspect-discord-bot-{deployment_name}.{subdomain}.workers.dev/interactions
```

as the **Interactions Endpoint URL** in the Discord Developer Portal.

### 3. Register slash commands

Run from the repository root:

```bash
DISCORD_APPLICATION_ID="your-app-id" \
DISCORD_BOT_TOKEN="your-bot-token" \
npm run register:commands -w @open-inspect/discord-bot
```

For faster iteration, you can register commands to a single test server:

```bash
DISCORD_APPLICATION_ID="your-app-id" \
DISCORD_BOT_TOKEN="your-bot-token" \
DISCORD_GUILD_ID="your-server-id" \
npm run register:commands -w @open-inspect/discord-bot
```

## Slash Commands

### `/inspect`

Starts a coding session.

Options:

- `prompt` - required instruction for the agent
- `repo` - optional explicit `owner/name` override

Behavior:

- in a normal channel, the bot tries to create a Discord thread for the session
- in an existing mapped thread, the bot reuses the current session
- if repo classification is ambiguous, the bot returns a select menu for clarification

### `/inspect-settings`

Shows a Discord select-menu UI for:

- preferred model
- preferred reasoning effort

Preferences are stored per Discord user in KV.

## Web App Integration Settings

The Open-Inspect web app exposes a **Settings -> Integrations -> Discord Bot** panel for
configuring:

- default model and reasoning effort
- whether Discord user preferences can override defaults
- whether new `/inspect` requests create Discord threads automatically
- optional prompt instructions appended to all Discord sessions
- repository allowlists and per-repository overrides

These settings are stored in the control plane and resolved per repository before a Discord session
is created.

## Authentication

### Discord webhook verification

Incoming interaction requests are verified using Discord's required Ed25519 signature flow:

1. Read `X-Signature-Ed25519`
2. Read `X-Signature-Timestamp`
3. Verify the signature over `timestamp + raw_body` using `DISCORD_PUBLIC_KEY`
4. Reject the request on mismatch

### Control plane auth

Requests to the control plane use HMAC bearer tokens derived from `INTERNAL_CALLBACK_SECRET`, the
same internal auth mechanism used by the other bot workers.

### Completion callback auth

The control plane posts results to `/callbacks/complete` with an HMAC-signed payload. The Discord
bot verifies the signature before fetching session output and posting the final message.

## Repo Resolution

The bot resolves the repository using this cascade:

1. explicit `repo` slash-command option
2. existing thread-to-session mapping
3. channel association metadata from repo settings
4. LLM classifier over prompt text + channel context + thread history
5. user clarification via Discord select menu

## API Endpoints

| Endpoint              | Method | Description                                |
| --------------------- | ------ | ------------------------------------------ |
| `/health`             | GET    | Health check                               |
| `/interactions`       | POST   | Discord interactions webhook               |
| `/callbacks/complete` | POST   | Completion callback from the control plane |

## Development

```bash
# Install dependencies from repo root
npm install

# Build
npm run build -w @open-inspect/discord-bot

# Type check
npm run typecheck -w @open-inspect/discord-bot

# Register slash commands for testing
DISCORD_APPLICATION_ID="..." DISCORD_BOT_TOKEN="..." npm run register:commands -w @open-inspect/discord-bot
```

## Package Structure

```
src/
├── index.ts                  # Hono app, interaction routing, session creation flow
├── callbacks.ts              # Completion callback verification and posting
├── logger.ts                 # Structured JSON logger
├── types/
│   └── index.ts              # Env bindings and Discord payload types
├── classifier/
│   ├── index.ts              # Repo classification logic
│   └── repos.ts              # Control-plane repo fetching and caching
├── completion/
│   ├── extractor.ts          # Session event/artifact extraction
│   └── message.ts            # Discord completion message formatting
└── utils/
    ├── discord-client.ts     # Discord REST API helpers and signature verification
    ├── internal.ts           # Re-export of shared internal auth helper
    └── repo.ts               # Repo normalization helpers
```
