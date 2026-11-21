#!/usr/bin/env bash
# Deskverse DV-004A: one-time local PostgreSQL setup for WSL2 Ubuntu.
#
# Run it yourself, from the repository root, as your normal user:
#
#   bash scripts/db/setup-local.sh
#
# It calls `sudo` for the system steps, so sudo asks for your password in
# your own terminal. The script never reads, prints or stores that password.
#
# What it does (safe to run again; it never drops anything):
#   1. Installs Ubuntu's own `postgresql` and `postgresql-client` packages.
#   2. Adds one drop-in file so the server listens on 127.0.0.1 only:
#      /etc/postgresql/<version>/main/conf.d/deskverse.conf
#      pg_hba.conf is NOT edited. Ubuntu's default already requires
#      scram-sha-256 passwords for 127.0.0.1 connections; the script checks.
#   3. Enables and starts the service (systemd), so it starts with WSL.
#   4. Creates two login roles and their own databases:
#        deskverse_app  → database deskverse       (development data)
#        deskverse_test → database deskverse_test  (tests; may create and
#                         drop its own deskverse_test_* scratch databases)
#      Neither is a superuser. Each database only accepts its own role.
#   5. Writes random passwords into .env.local (mode 600), as DATABASE_URL
#      and DATABASE_TEST_URL. An existing entry is kept, never overwritten.
set -euo pipefail

cd "$(dirname "$0")/../.."
ENV_FILE=.env.local
APP_ROLE=deskverse_app
APP_DB=deskverse
TEST_ROLE=deskverse_test
TEST_DB=deskverse_test
PORT=5432

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nSetup stopped: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || fail "run this as your normal user, not with sudo (it asks for sudo itself)."
command -v systemctl >/dev/null || fail "systemd isn't available. Enable it in /etc/wsl.conf ([boot] systemd=true) and restart WSL."

say "Installing PostgreSQL from Ubuntu's package repository"
sudo apt-get update
sudo apt-get install -y postgresql postgresql-client openssl

VERSION=$(ls /etc/postgresql | sort -V | tail -1)
[ -n "$VERSION" ] || fail "no PostgreSQL cluster was found under /etc/postgresql."
CONF_DIR=/etc/postgresql/$VERSION/main
say "PostgreSQL $VERSION (cluster $CONF_DIR)"

sudo grep -Eq "^\s*include_dir\s*=\s*'conf.d'" "$CONF_DIR/postgresql.conf" ||
  fail "$CONF_DIR/postgresql.conf doesn't include conf.d; refusing to edit it."
if sudo grep -Eq "^\s*port\s*=\s*$PORT\b" "$CONF_DIR/postgresql.conf"; then :; else
  fail "the cluster isn't configured for port $PORT. Edit DATABASE_URL by hand instead."
fi

say "Listening on 127.0.0.1 only"
printf "# Deskverse (DV-004A): accept local TCP connections on IPv4 loopback only.\nlisten_addresses = '127.0.0.1'\n" |
  sudo tee "$CONF_DIR/conf.d/deskverse.conf" >/dev/null

say "Checking password authentication for 127.0.0.1 (pg_hba.conf is not changed)"
sudo grep -Eq '^\s*host\s+all\s+all\s+127\.0\.0\.1/32\s+scram-sha-256\s*$' "$CONF_DIR/pg_hba.conf" ||
  fail "pg_hba.conf has no 'host all all 127.0.0.1/32 scram-sha-256' rule. Add one deliberately, then run this again."

say "Enabling and (re)starting the service"
sudo systemctl enable postgresql >/dev/null
sudo systemctl restart postgresql
for _ in $(seq 1 30); do
  sudo -u postgres pg_isready -q -h 127.0.0.1 -p "$PORT" && break
  sleep 0.5
done
sudo -u postgres pg_isready -h 127.0.0.1 -p "$PORT" || fail "the server didn't start. See: sudo journalctl -u postgresql@$VERSION-main"

psql_admin() { sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d postgres "$@"; }
role_exists() { [ "$(psql_admin -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$1'")" = 1 ]; }
db_exists() { [ "$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '$1'")" = 1 ]; }
env_has() { [ -f "$ENV_FILE" ] && grep -Eq "^$1=" "$ENV_FILE"; }

umask 077
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

# setup_role ROLE DB VAR ROLE_OPTIONS
setup_role() {
  local role=$1 db=$2 var=$3 options=$4 password=""
  if env_has "$var" && role_exists "$role"; then
    say "$role: keeping the existing $var in $ENV_FILE"
  else
    password=$(openssl rand -hex 24)
    # The password goes to psql on stdin, never on a command line.
    if role_exists "$role"; then
      say "$role: exists but $ENV_FILE has no $var; setting a new password"
      psql_admin <<SQL
SET password_encryption = 'scram-sha-256';
ALTER ROLE $role WITH LOGIN $options PASSWORD '$password';
SQL
    else
      say "$role: creating the role"
      psql_admin <<SQL
SET password_encryption = 'scram-sha-256';
CREATE ROLE $role WITH LOGIN $options PASSWORD '$password';
SQL
    fi
    if env_has "$var"; then
      # Replace only this variable's line.
      local tmp
      tmp=$(mktemp "$ENV_FILE.XXXXXX")
      grep -Ev "^$var=" "$ENV_FILE" >"$tmp" || true
      mv "$tmp" "$ENV_FILE"
    fi
    printf '%s=postgresql://%s:%s@127.0.0.1:%s/%s\n' "$var" "$role" "$password" "$PORT" "$db" >>"$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
  if ! db_exists "$db"; then
    say "$db: creating the database (owner $role)"
    sudo -u postgres createdb -O "$role" "$db"
  fi
  # Only the owner may connect (the superuser always can).
  psql_admin -c "REVOKE CONNECT, TEMPORARY ON DATABASE $db FROM PUBLIC" \
    -c "GRANT CONNECT, TEMPORARY ON DATABASE $db TO $role"
}

setup_role "$APP_ROLE" "$APP_DB" DATABASE_URL "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"
setup_role "$TEST_ROLE" "$TEST_DB" DATABASE_TEST_URL "NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"
# Development and test roles can't reach each other's database.
psql_admin -c "REVOKE CONNECT ON DATABASE $APP_DB FROM $TEST_ROLE" \
  -c "REVOKE CONNECT ON DATABASE $TEST_DB FROM $APP_ROLE"

say "Checking"
sudo -u postgres psql -X -tAc "SELECT version()" -d postgres
echo "Listening sockets:"
ss -ltn "sport = :$PORT" | tail -n +2
echo "$ENV_FILE: $(stat -c '%a %U' "$ENV_FILE")"

cat <<'DONE'

PostgreSQL is set up. Next, from the repository root:

  yarn db:migrate      # apply the schema to the development database
  yarn db:check        # confirm the app can connect

Passwords are only in .env.local (not printed, not committed).
DONE
