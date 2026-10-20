#!/usr/bin/env bash
# Store-review hub: a disposable Arca hub with sample content and a password-protected
# page that issues pairing codes. Runs as root on the server from /srv/arca-review/kit.
#   up VERSION       install or update everything, seed a fresh hub, start it
#   down             stop the hub and the page and take the site offline (data kept)
#   wipe --yes       down, then delete the hub's data so the next up seeds a fresh hub
#   status           services, image and hub answer
#   devices          devices paired with the hub
#   remove-devices   remove every paired device (reviewers' phones)
set -euo pipefail

DOMAIN=arca-review.satoshi-ltd.com
BASE=/srv/arca-review
KIT=$BASE/kit
PRIVATE=$BASE/private
DISK=$PRIVATE/data.img
DATA=$PRIVATE/data
ACME=$BASE/acme
ETC=/etc/arca-review
SUBNET=172.30.77.0/24
HUB_PORT=17841
PAGE_PORT=8791
CREDENTIALS=/root/arca-review-credentials.txt
SITE=/etc/nginx/sites-available/$DOMAIN
ENABLED=/etc/nginx/sites-enabled/$DOMAIN
CERT=/etc/letsencrypt/live/$DOMAIN
MOUNT=$(systemd-escape -p --suffix=mount "$DATA")

[ "$(id -u)" = 0 ] || { echo "Run as root" >&2; exit 1; }
[ "$(cd "$(dirname "$0")" && pwd)" = "$KIT" ] || { echo "Copy the kit to $KIT first" >&2; exit 1; }

hub_answers() { curl -fsS -m 3 "http://127.0.0.1:$HUB_PORT/.well-known/arca" >/dev/null 2>&1; }

# Admin calls read the token from its file, so it never appears in process arguments.
hub_admin() {
  python3 -I - "$ETC/admin-token" "http://127.0.0.1:$HUB_PORT" "$@" <<'EOF'
import json, sys, urllib.request
token = open(sys.argv[1]).read().strip()
hub, action = sys.argv[2], sys.argv[3]
def call(route, body=None):
    request = urllib.request.Request(hub + route, method="GET" if body is None else "POST",
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)
devices = [m for m in call("/v1/machines")["machines"] if not m.get("isHub")]
for m in devices:
    if action == "remove":
        call("/v1/revoke", {"id": m["credentialId"]})
    print(("removed " if action == "remove" else "") + f"{m['name']} · last sync {m.get('lastSync') or 'never'} · {m['credentialId']}")
if not devices:
    print("No paired devices")
EOF
}

site_off() {
  [ -L "$ENABLED" ] || return 0
  rm "$ENABLED"
  if nginx -t -q; then systemctl reload nginx; else echo "nginx -t failed; the review site is disabled but nginx was not reloaded" >&2; fi
}

down() {
  systemctl disable --now arca-review-codes.service arca-review.service 2>/dev/null || true
  site_off
  echo "Review hub stopped; data kept in $DISK"
}

install_units() {
  local image=$1
  id arca-review >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin arca-review
  id arca-review-hub >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin arca-review-hub
  local uid gid
  uid=$(id -u arca-review-hub)
  gid=$(id -g arca-review-hub)
  install -d -m 0750 -o root -g arca-review "$ETC"
  printf 'ARCA_REVIEW_IMAGE=%s\nARCA_REVIEW_USER=%s:%s\n' "$image" "$uid" "$gid" >"$ETC/env"

  # The hub's state holds its admin token: keep the image and its mount root-only.
  install -d -m 0700 "$PRIVATE"
  if [ ! -f "$DISK" ]; then
    fallocate -l 2G "$DISK"
    mkfs.ext4 -q -F "$DISK"
  fi
  chmod 0600 "$DISK"
  mountpoint -q "$DATA" || install -d -m 0700 "$DATA"
  cat >"/etc/systemd/system/$MOUNT" <<EOF
[Unit]
Description=Arca review hub data (2 GB image)

[Mount]
What=$DISK
Where=$DATA
Type=ext4
Options=loop,nodev,nosuid,noexec

[Install]
WantedBy=multi-user.target
EOF

  # The hub reaches nothing: no Internet, no host services, no private networks.
  cat >"$ETC/firewall.sh" <<EOF
#!/bin/sh
set -e
for chain in ARCA-REVIEW-OUT ARCA-REVIEW-IN; do
  iptables -N \$chain 2>/dev/null || iptables -F \$chain
  iptables -A \$chain -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
done
iptables -A ARCA-REVIEW-OUT -d $SUBNET -j RETURN
iptables -A ARCA-REVIEW-OUT -j DROP
iptables -A ARCA-REVIEW-IN -j DROP
iptables -C DOCKER-USER -s $SUBNET -j ARCA-REVIEW-OUT 2>/dev/null || iptables -I DOCKER-USER -s $SUBNET -j ARCA-REVIEW-OUT
iptables -C INPUT -s $SUBNET -j ARCA-REVIEW-IN 2>/dev/null || iptables -I INPUT -s $SUBNET -j ARCA-REVIEW-IN
EOF
  chmod 0755 "$ETC/firewall.sh"

  cat >/etc/systemd/system/arca-review.service <<EOF
[Unit]
Description=Arca store-review hub (Docker)
After=docker.service $MOUNT
Requires=docker.service $MOUNT

[Service]
EnvironmentFile=$ETC/env
ExecStartPre=$ETC/firewall.sh
ExecStartPre=-/usr/bin/docker rm -f arca-review
# Only this unit runs the hub, so a lock left by a killed container is stale.
ExecStartPre=/bin/rm -f $DATA/state/daemon.lock
ExecStart=/usr/bin/docker run --rm --init --name arca-review --network arca-review \\
  -p 127.0.0.1:$HUB_PORT:17831 -v $DATA:/data --user \${ARCA_REVIEW_USER} \\
  --read-only --tmpfs /tmp:size=64m --cap-drop ALL --security-opt no-new-privileges \\
  --memory 512m --memory-swap 512m --cpus 0.5 --pids-limit 256 \\
  -e MALLOC_ARENA_MAX=2 -e VIPS_CONCURRENCY=1 \\
  \${ARCA_REVIEW_IMAGE} daemon --port 17831 --host 0.0.0.0 --private-network
ExecStop=/usr/bin/docker stop -t 20 arca-review
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  cat >/etc/systemd/system/arca-review-codes.service <<EOF
[Unit]
Description=Arca store-review pairing page (127.0.0.1:$PAGE_PORT)
After=arca-review.service
Requires=arca-review.service

[Service]
User=arca-review
Group=arca-review
Environment=ARCA_REVIEW_ADDRESS=https://$DOMAIN
Environment=ARCA_REVIEW_HUB=http://127.0.0.1:$HUB_PORT
Environment=ARCA_REVIEW_PAGE_PORT=$PAGE_PORT
Environment=ARCA_REVIEW_TOKEN_FILE=$ETC/admin-token
ExecStart=/usr/bin/python3 -I $KIT/codes.py
Restart=always
RestartSec=5
MemoryMax=64M
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
IPAddressAllow=localhost
IPAddressDeny=any
InaccessiblePaths=$PRIVATE -/var/www -/etc/nginx -/etc/letsencrypt

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$MOUNT"
  # The hub's user must traverse the disk's root; $PRIVATE keeps everyone else out.
  chmod 0755 "$DATA"
  install -d -m 0700 -o "$uid" -g "$gid" "$DATA/state" "$DATA/files"
  docker network inspect arca-review >/dev/null 2>&1 || docker network create --ipv6=false --subnet "$SUBNET" arca-review >/dev/null
}

cloudflare_ranges() {
  local v4 v6 ranges
  v4=$(curl -fsS -m 15 https://www.cloudflare.com/ips-v4 || true)
  v6=$(curl -fsS -m 15 https://www.cloudflare.com/ips-v6 || true)
  ranges=$(printf '%s\n%s\n' "$v4" "$v6" | grep -E '^[0-9a-f:.]+/[0-9]+$' || true)
  if [ "$(printf '%s\n' "$ranges" | grep -c /)" -ge 10 ]; then
    printf '%s\n' "$ranges" | sed 's/$/ 1;/' >/etc/nginx/arca-review-cloudflare-geo.conf
    printf '%s\n' "$ranges" | sed 's/^/set_real_ip_from /;s/$/;/' >/etc/nginx/arca-review-cloudflare-realip.conf
  elif [ -s /etc/nginx/arca-review-cloudflare-geo.conf ]; then
    echo "Could not refresh Cloudflare's address ranges; keeping the saved ones" >&2
  else
    echo "Could not read Cloudflare's address ranges" >&2
    exit 1
  fi
}

write_site() {
  local tls=$1
  local new=$SITE.new
  cat >"$new" <<EOF
# Generated by $KIT/arca-review.sh on every up; edits are overwritten.
limit_req_zone \$binary_remote_addr zone=arca_review_page:1m rate=6r/m;
limit_req_zone \$binary_remote_addr zone=arca_review_pair:1m rate=1r/m;
geo \$realip_remote_addr \$arca_review_via_cloudflare {
    default 0;
    include /etc/nginx/arca-review-cloudflare-geo.conf;
}

server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ {
        root $ACME;
    }
    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF
  if [ "$tls" = 1 ]; then
    cat >>"$new" <<EOF

server {
    listen 443 ssl;
    server_name $DOMAIN;
    ssl_certificate $CERT/fullchain.pem;
    ssl_certificate_key $CERT/privkey.pem;
    $( [ -f /etc/letsencrypt/options-ssl-nginx.conf ] && echo "include /etc/letsencrypt/options-ssl-nginx.conf;" )
    $( [ -f /etc/letsencrypt/ssl-dhparams.pem ] && echo "ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;" )

    # Only Cloudflare reaches the origin; limits use the visitor's address.
    include /etc/nginx/arca-review-cloudflare-realip.conf;
    real_ip_header CF-Connecting-IP;
    if (\$arca_review_via_cloudflare = 0) {
        return 403;
    }
    # Node reads a backslash as a slash, which would walk out of /v1/.
    if (\$request_uri ~ "\\x5c|%5[cC]") {
        return 400;
    }
    client_max_body_size 16m;
    limit_req_status 429;

    location /.well-known/acme-challenge/ {
        root $ACME;
    }

    location = /review {
        auth_basic "Arca review";
        auth_basic_user_file /etc/nginx/arca-review.htpasswd;
        limit_req zone=arca_review_page burst=5 nodelay;
        proxy_pass http://127.0.0.1:$PAGE_PORT;
    }

    # Only the routes the app uses; the hub's web administration stays private.
    location = /.well-known/arca {
        proxy_pass http://127.0.0.1:$HUB_PORT;
    }
    location = /pair {
        limit_req zone=arca_review_pair burst=3 nodelay;
        proxy_pass http://127.0.0.1:$HUB_PORT;
    }
    location /v1/ {
        proxy_pass http://127.0.0.1:$HUB_PORT;
        proxy_http_version 1.1;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
    location / {
        return 404;
    }
}
EOF
  fi
  [ -f "$SITE" ] && cp "$SITE" "$SITE.previous"
  mv "$new" "$SITE"
  ln -sf "$SITE" "$ENABLED"
  if ! nginx -t -q; then
    if [ -f "$SITE.previous" ]; then mv "$SITE.previous" "$SITE"; else rm -f "$ENABLED"; fi
    if [ -L "$ENABLED" ] && nginx -t -q; then
      echo "nginx rejected the new review site; the previous one is back" >&2
    else
      rm -f "$ENABLED"
      echo "nginx rejected the review site; it is disabled until the configuration is fixed" >&2
    fi
    exit 1
  fi
  systemctl reload nginx
}

install_site() {
  if [ ! -f "$CREDENTIALS" ]; then
    (umask 077; printf 'user: appreview\npassword: %s\n' "$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)" >"$CREDENTIALS")
  fi
  sed -n 's/^password: //p' "$CREDENTIALS" | openssl passwd -apr1 -stdin | sed 's/^/appreview:/' >/etc/nginx/arca-review.htpasswd
  chown root:www-data /etc/nginx/arca-review.htpasswd
  chmod 0640 /etc/nginx/arca-review.htpasswd
  install -d -m 0755 "$ACME"
  cloudflare_ranges
  if [ ! -d "$CERT" ]; then
    write_site 0
    certbot certonly --webroot -w "$ACME" -d "$DOMAIN" --non-interactive --deploy-hook "systemctl reload nginx"
    write_site 1
  else
    write_site 1
    certbot renew --cert-name "$DOMAIN" --non-interactive --quiet
  fi
}

up() {
  local version=${1:-}
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Usage: up VERSION (for example 0.6.119)" >&2; exit 1; }
  local image=satoshiltd/arca:$version
  docker pull -q "$image" >/dev/null
  install_units "$image"
  local user
  user=$(sed -n 's/^ARCA_REVIEW_USER=//p' "$ETC/env")
  if [ -f "$DATA/state/config.json" ] && [ ! -f "$DATA/.seeded" ]; then
    echo "This hub was never seeded completely; run wipe --yes, then up again" >&2
    exit 1
  fi
  local fresh=
  if [ ! -f "$DATA/state/config.json" ]; then
    fresh=1
    docker run --rm --network none --user "$user" -v "$DATA:/data" "$image" \
      init --role hub --name "Arca Review" --root /data/files --host 0.0.0.0 --port 17831 >/dev/null
  fi
  systemctl enable arca-review.service >/dev/null
  systemctl restart arca-review.service
  for _ in $(seq 60); do hub_answers && break; sleep 2; done
  hub_answers || { journalctl -u arca-review -n 30 --no-pager; exit 1; }
  install -m 0640 -o root -g arca-review /dev/null "$ETC/admin-token"
  python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["adminToken"])' "$DATA/state/config.json" >"$ETC/admin-token"
  if [ -n "$fresh" ]; then
    echo "Seeding sample content…"
    docker run --rm --init --network arca-review --user "$user" -v "$DATA:/data" -v "$KIT:/app/review:ro" \
      --read-only --tmpfs /tmp:size=128m --cap-drop ALL --security-opt no-new-privileges --memory 512m --cpus 0.5 \
      --entrypoint node "$image" /app/review/seed.mjs
    touch "$DATA/.seeded"
  fi
  systemctl enable arca-review-codes.service >/dev/null
  systemctl restart arca-review-codes.service
  install_site
  echo "Review hub $version is up at https://$DOMAIN — page https://$DOMAIN/review"
  echo "Page credentials: $CREDENTIALS"
}

status() {
  systemctl is-active arca-review.service arca-review-codes.service "$MOUNT" || true
  sed -n 's/^ARCA_REVIEW_IMAGE=//p' "$ETC/env" 2>/dev/null
  if hub_answers; then echo "hub answers on 127.0.0.1:$HUB_PORT"; else echo "hub not answering"; fi
  if [ -L "$ENABLED" ]; then echo "site enabled"; else echo "site disabled"; fi
  echo "IPv6 on the hub network: $(docker network inspect -f '{{.EnableIPv6}}' arca-review 2>/dev/null || echo unknown)"
  df -h "$DATA" 2>/dev/null | tail -1
}

case "${1:-}" in
  up) up "${2:-}" ;;
  down) down ;;
  wipe)
    [ "${2:-}" = --yes ] || { echo "wipe deletes the review hub's data; run: wipe --yes" >&2; exit 1; }
    down
    systemctl disable --now "$MOUNT" 2>/dev/null || true
    if mountpoint -q "$DATA"; then echo "$DATA is still mounted; nothing deleted" >&2; exit 1; fi
    rm -f "$DISK" "$ETC/admin-token"
    echo "Review hub data deleted; the next up seeds a fresh hub"
    ;;
  status) status ;;
  devices) hub_admin list ;;
  remove-devices) hub_admin remove ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac
