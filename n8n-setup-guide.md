# n8n Self-Hosted Setup (Docker on Windows)

## Prerequisites

1. **Docker Desktop** installed and running — [download here](https://www.docker.com/products/docker-desktop/)
2. **WSL2** enabled (Docker Desktop handles this during install)

---

## Step 1 — Save the docker-compose file

Create a folder for n8n, e.g. `C:\n8n`, and place `docker-compose.yml` inside it.

---

## Step 2 — Customize settings

Open `docker-compose.yml` and update:

| Variable                    | Default              | What to change                                                                    |
| --------------------------- | -------------------- | --------------------------------------------------------------------------------- |
| `N8N_BASIC_AUTH_USER`     | `admin`            | Your preferred username                                                           |
| `N8N_BASIC_AUTH_PASSWORD` | `changeme123`      | A strong password                                                                 |
| `GENERIC_TIMEZONE`        | `Asia/Ho_Chi_Minh` | Your timezone ([list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)) |

---

## Step 3 — Start n8n

Open **PowerShell** or **Command Prompt** in the folder with `docker-compose.yml`:

```powershell
cd C:\n8n
docker compose up -d
```

n8n will pull the image and start in the background.

---

## Step 4 — Access n8n

Open your browser and go to: **http://localhost:5678**

Log in with the username and password you set in the compose file.

---

## Useful commands

```powershell
# View logs
docker compose logs -f

# Stop n8n
docker compose down

# Update to latest version
docker compose pull
docker compose up -d

# Check status
docker ps
```

---

## Data persistence

Your workflows and credentials are stored in a Docker volume named `n8n_data`. This persists across restarts and updates.

To back up your data:

```powershell
docker run --rm -v n8n_data:/data -v C:\n8n\backup:/backup alpine tar czf /backup/n8n-backup.tar.gz /data
```

---

## Exposing n8n to the internet (optional)

If you need webhooks from external services (e.g. GitHub, Stripe), you'll need to expose n8n publicly. Options:

- **Cloudflare Tunnel** (free, recommended) — no port forwarding needed
- **ngrok** — quick for testing
- **Reverse proxy** (nginx/Caddy) + router port forwarding

For Cloudflare Tunnel:

```powershell
# Install cloudflared, then:
cloudflared tunnel --url http://localhost:5678
```
