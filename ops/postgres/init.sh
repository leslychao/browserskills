#!/bin/sh
set -eu
# A dedicated non-superuser owns only the application database. Secret is never a CLI argument.
APP_PASSWORD=$(cat /run/secrets/db_password)
export APP_PASSWORD
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-psqlrc --set ON_ERROR_STOP=1 <<'SQL'
\getenv app_password APP_PASSWORD
SET log_statement = 'none';
CREATE ROLE browserskills LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER DATABASE browserskills OWNER TO browserskills;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO browserskills;
SQL
unset APP_PASSWORD
