[![](apps/web/app/opengraph-image.jpg)](https://www.getinboxzero.com)

<p align="center">
  <a href="https://www.getinboxzero.com">
    <h1 align="center">Inbox Zero - your 24/7 AI email assistant</h1>
  </a>
  <p align="center">
    Organizes your inbox, pre-drafts replies, manages your calendar, and organizes attachments. Chat with it from Slack or Telegram to manage your inbox on the go. Open source alternative to Fyxer, but more customizable and secure.
    <br />
    <a href="https://www.getinboxzero.com">Website</a>
    ·
    <a href="https://www.getinboxzero.com/discord">Discord</a>
    ·
    <a href="https://github.com/elie222/inbox-zero/issues">Issues</a>
  </p>
</p>

<div align="center">

![Stars](https://img.shields.io/github/stars/elie222/inbox-zero?labelColor=black&style=for-the-badge&color=2563EB)
![Forks](https://img.shields.io/github/forks/elie222/inbox-zero?labelColor=black&style=for-the-badge&color=2563EB)

<a href="https://trendshift.io/repositories/6400" target="_blank"><img src="https://trendshift.io/api/badge/repositories/6400" alt="elie222%2Finbox-zero | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>

[![Sponsor](https://readme.cash/i/hg3bchcqpo.svg)](https://readme.cash/c/hg3bchcqpo)

[![Vercel OSS Program](https://vercel.com/oss/program-badge.svg)](https://vercel.com/oss)

</div>

## Mission

To help you spend less time in your inbox, so you can focus on what matters most.

## Features

- **AI Personal Assistant:** Organizes your inbox and pre-drafts replies in your tone and style.
- **AI Rules for email:** Explain in plain English how your AI should handle your inbox.
- **Reply Zero:** Track emails to reply to and those awaiting responses.
- **Bulk Unsubscriber:** One-click unsubscribe and archive emails you never read.
- **Bulk Archiver:** Clean up your inbox by bulk archiving old emails.
- **Cold Email Blocker:** Auto‑block cold emails.
- **Email Analytics:** Track your activity and trends over time.
- **Meeting Briefs:** Get personalized briefings before every meeting, pulling context from your email and calendar.
- **Smart Filing:** Automatically save email attachments to Google Drive or OneDrive.
- **Slack & Telegram Integration:** Chat with your AI assistant from Slack or Telegram to manage your inbox without leaving the apps you already use.


Learn more in our [docs](https://docs.getinboxzero.com).

## Feature Screenshots

| ![AI Assistant](.github/screenshots/email-assistant.png) |        ![Reply Zero](.github/screenshots/reply-zero.png)        |
| :------------------------------------------------------: | :-------------------------------------------------------------: |
|                      _AI Assistant_                      |                          _Reply Zero_                           |
|  ![Gmail Client](.github/screenshots/email-client.png)   | ![Bulk Unsubscriber](.github/screenshots/bulk-unsubscriber.png) |
|                      _Gmail client_                      |                       _Bulk Unsubscriber_                       |

## Demo Video

[![Inbox Zero demo](https://img.youtube.com/vi/UusnveLKwWM/maxresdefault.jpg)](https://youtu.be/UusnveLKwWM)

## Built with

- [Next.js](https://nextjs.org/)
- [Tailwind CSS](https://tailwindcss.com/)
- [shadcn/ui](https://ui.shadcn.com/)
- [Prisma](https://www.prisma.io/)
- [Upstash](https://upstash.com/)
- [Turborepo](https://turbo.build/)
- [Popsy Illustrations](https://popsy.co/)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=elie222/inbox-zero&type=Date)](https://www.star-history.com/#elie222/inbox-zero&Date)

## Feature Requests

To request a feature open a [GitHub issue](https://github.com/elie222/inbox-zero/issues), or join our [Discord](https://www.getinboxzero.com/discord).

## Getting Started

We offer a hosted version of Inbox Zero at [getinboxzero.com](https://www.getinboxzero.com).

### Self-Hosting

The fastest way to self-host Inbox Zero is with the CLI:

> **Prerequisites**: [Docker](https://docs.docker.com/engine/install/) and [Node.js](https://nodejs.org/) v24+

```bash
npx @inbox-zero/cli setup      # One-time setup wizard
npx @inbox-zero/cli start      # Start containers
```

Open http://localhost:3000

For complete self-hosting instructions, production deployment, OAuth setup, and configuration options, see our **[Self-Hosting Docs](https://docs.getinboxzero.com/hosting/quick-start)**.

#### Does Inbox Zero replace my mailbox?

Inbox Zero usually **complements** your existing email setup, not replaces it.

- You keep your existing mailbox provider and address (for example Gmail, Outlook, or an IMAP inbox).
- Inbox Zero sits on top as the AI inbox, automation, and triage layer.
- For many users it can replace the **day-to-day email client UI**, but it does **not** replace the underlying mailbox/account that stores and delivers your email.

#### Deploying with Dockploy

If you want to run Inbox Zero in Dockploy, use Dockploy for the containers and scheduler, and keep your cron jobs out of Docker Compose.

1. **Prepare your server**
   - Install Docker on the host.
   - Install Dockploy and connect it to your server.
   - Point a domain or subdomain at the server for the web app.

2. **Create the data services**
   - Add a PostgreSQL service.
   - Add a Redis service.
   - If you want the same Redis-over-HTTP setup as `docker-compose.yml`, also add `hiett/serverless-redis-http:latest`.

3. **Create the Inbox Zero web service**
   - Image: `ghcr.io/elie222/inbox-zero:latest`
   - Port: `3000`
   - Public URL: set this to the domain you assigned in Dockploy.

4. **Set the required app environment variables**
   - Minimum required values:
     - `NEXT_PUBLIC_BASE_URL`
     - `DATABASE_URL`
     - `DIRECT_URL`
     - `UPSTASH_REDIS_URL`
     - `UPSTASH_REDIS_TOKEN`
     - `AUTH_SECRET`
     - `EMAIL_ENCRYPT_SECRET`
     - `EMAIL_ENCRYPT_SALT`
     - `INTERNAL_API_KEY`
     - `API_KEY_SALT`
     - `CRON_SECRET`
   - Then add your provider credentials (for example Google, Microsoft, Slack, Telegram, or LLM keys) as needed.
   - If you are using IMAP accounts, also add:
     - `IMAP_POLL_ENABLED=true`
     - `IMAP_POLL_BATCH_SIZE=100`
     - `IMAP_POLL_MESSAGE_LIMIT=30`
   - You can copy the full list from `apps/web/.env.example`.

5. **Optional: add the worker service**
   - Use the same image: `ghcr.io/elie222/inbox-zero:latest`
   - Command: `/app/docker/scripts/start-worker.sh`
   - Only needed when you want a dedicated BullMQ worker (`QUEUE_BACKEND=bullmq`).

6. **Start the stack**
   - Deploy the services in Dockploy.
   - Open your Inbox Zero domain and complete the onboarding flow.
   - Connect your mailbox provider.

7. **Create Dockploy scheduler jobs instead of running the `cron` container**
   - Recreate the compose cron calls as Dockploy HTTP schedules.
   - Use the same `Authorization` header as the other cron endpoints.
   - Recommended jobs from `docker-compose.yml`:
     - `GET /api/cron/scheduled-actions` every 15 minutes
     - `GET /api/cron/automation-jobs` every 15 minutes
     - `GET /api/follow-up-reminders` every 60 minutes
     - `GET /api/resend/digest/all` every 30 minutes
     - `GET /api/meeting-briefs` every 15 minutes
     - `GET /api/meeting-recorder/schedule` every 5 minutes
     - `GET /api/watch/all` every 6 hours
   - If you use IMAP, also add:
     - `GET /api/cron/imap-poll`

8. **Verify the installation**
   - Confirm the web app loads.
   - Confirm you can sign in and connect a mailbox.
   - Trigger one scheduler job manually and confirm it returns a successful response.

### Local Development

> **Prerequisites**: [Docker](https://docs.docker.com/engine/install/), [Node.js](https://nodejs.org/) v24+, and [pnpm](https://pnpm.io/) v10+

```bash
git clone https://github.com/elie222/inbox-zero.git
cd inbox-zero
docker compose -f docker-compose.dev.yml up -d   # Postgres + Redis
pnpm install
npm run setup                                     # Interactive env setup
cd apps/web && pnpm prisma migrate dev && cd ../..
pnpm dev
```

Open http://localhost:3000

After `pnpm install`, if you want to use the local Google emulator, start it with:

```bash
docker compose -f docker-compose.dev.yml --profile google-emulator up -d
```

Then point `apps/web/.env` at it with:

```bash
GOOGLE_BASE_URL=http://localhost:4002
GOOGLE_CLIENT_ID=emulate-google-client.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=emulate-google-secret
```

If you want to use the local Microsoft emulator, start it with:

```bash
docker compose -f docker-compose.dev.yml --profile microsoft-emulator up -d
```

Then point `apps/web/.env` at it with:

```bash
MICROSOFT_BASE_URL=http://localhost:4003
MICROSOFT_CLIENT_ID=emulate-microsoft-client-id
MICROSOFT_CLIENT_SECRET=emulate-microsoft-secret
```

See the **[Contributing Guide](https://docs.getinboxzero.com/contributing)** for more details including devcontainer setup.

## Contributing

View open tasks in [GitHub Issues](https://github.com/elie222/inbox-zero/issues) and join our [Discord](https://www.getinboxzero.com/discord) to discuss what's being worked on.

Docker images are automatically built on every push to `main` and tagged with the commit SHA (e.g., `elie222/inbox-zero:abc1234`). The `latest` tag always points to the most recent main build. Formal releases use version tags (e.g., `v2.26.0`).
