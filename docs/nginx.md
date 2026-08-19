# Nginx and HTTPS deployment

This setup uses separate Nginx sites for the Docker services:

```text
Browser → ricos.rwandaiqs.org:443     → 127.0.0.1:3000 (frontend)
API     → api.ricos.rwandaiqs.org:443 → 127.0.0.1:5000 (backend)
```

The site files are stored at the repository roots:

- `frontend/riqs-membership`
- `backend/riqs-membership-api`

Copy each file to `/etc/nginx/sites-available/`. The Docker Compose files
should expose the services on the host ports used below.

## 1. DNS and Docker

Create `A` records for both hostnames, pointing to the server's public IP:

```text
ricos.rwandaiqs.org      → SERVER_PUBLIC_IP
api.ricos.rwandaiqs.org  → SERVER_PUBLIC_IP
```

On the server, deploy both applications and verify their local health:

```bash
curl http://127.0.0.1:5000/health
curl -I http://127.0.0.1:3000/
```

Start the services with their deployment scripts:

```bash
cd /path/to/riqs-membership/backend
./scripts/deploy.sh --pull

cd /path/to/riqs-membership/frontend
./scripts/deploy.sh --pull
```

## 2. Install Nginx

On Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y nginx
```

Copy the supplied configurations:

```bash
sudo cp /path/to/riqs-membership/frontend/riqs-membership \
  /etc/nginx/sites-available/riqs-membership

sudo cp /path/to/riqs-membership/backend/riqs-membership-api \
  /etc/nginx/sites-available/riqs-membership-api
```

Or create it manually as requested:

```bash
sudo nano /etc/nginx/sites-available/riqs-membership
# and, separately:
sudo nano /etc/nginx/sites-available/riqs-membership-api
```

Then enable it with the symbolic link:

```bash
sudo ln -s /etc/nginx/sites-available/riqs-membership \
  /etc/nginx/sites-enabled/riqs-membership

sudo ln -s /etc/nginx/sites-available/riqs-membership-api \
  /etc/nginx/sites-enabled/riqs-membership-api
```

If the link already exists, use:

```bash
sudo ln -sfn /etc/nginx/sites-available/riqs-membership \
  /etc/nginx/sites-enabled/riqs-membership

sudo ln -sfn /etc/nginx/sites-available/riqs-membership-api \
  /etc/nginx/sites-enabled/riqs-membership-api
```

Disable the default site if it conflicts:

```bash
sudo rm -f /etc/nginx/sites-enabled/default
```

Validate and reload:

```bash
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

## 3. Verify HTTP routing

```bash
curl -i http://ricos.rwandaiqs.org/nginx-health
curl -i http://api.ricos.rwandaiqs.org/nginx-health
curl -i http://api.ricos.rwandaiqs.org/health
curl -I http://ricos.rwandaiqs.org/
```

The frontend `/nginx-health` endpoint confirms Nginx is responding. The API
`/health` endpoint confirms Nginx can reach the backend and the backend can
reach its database. The frontend root request confirms Next.js is reachable.

## 4. Install HTTPS with Certbot

Ensure DNS is propagated and ports 80/443 are allowed through the firewall:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Install Certbot's Nginx plugin:

```bash
sudo apt install -y certbot python3-certbot-nginx
```

Request and install the certificate:

```bash
sudo certbot --nginx -d ricos.rwandaiqs.org -d api.ricos.rwandaiqs.org
```

Choose the redirect option when Certbot asks whether HTTP should redirect to
HTTPS. Certbot will update the server block and reload Nginx.

Verify HTTPS:

```bash
curl -i https://ricos.rwandaiqs.org/nginx-health
curl -i https://api.ricos.rwandaiqs.org/nginx-health
curl -i https://api.ricos.rwandaiqs.org/health
curl -I https://ricos.rwandaiqs.org/
```

## 5. Certificate renewal

Certbot normally installs a systemd timer. Test renewal safely:

```bash
sudo certbot renew --dry-run
systemctl list-timers | grep certbot
```

Do not run `certbot renew --force-renewal` routinely; certificates are renewed
automatically when close to expiry.

## 6. Troubleshooting

- `502 Bad Gateway`: check `docker compose ps`, backend/frontend logs, and that ports 5000/3000 are listening on localhost.
- `nginx -t` fails: inspect the reported line and verify the site symlink.
- Certificate issuance fails: verify the DNS `A` record and that port 80 is publicly reachable.
- API works locally but not through the domain: test `/health` on the API hostname, then inspect `/var/log/nginx/error.log`.
- WebSockets disconnect: confirm the `/socket.io/` location and Upgrade/Connection headers are present.
- Uploads fail: increase `client_max_body_size` in `backend/riqs-membership-api` if the deployment requires files larger than 25 MB.
