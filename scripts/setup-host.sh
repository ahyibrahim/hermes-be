#!/usr/bin/env bash
#
# One-time host provisioning for a hermes-be instance.
#
#   sudo ./scripts/setup-host.sh [instance]     # instance defaults to p1
#
# Creates the hermes service user, the per-instance directories, the env file
# and the systemd unit, then enables hermes-be@<instance>. Needs root, because
# it creates a system user and writes under /srv, /var/lib and /etc.
#
# Idempotent: safe to re-run. It never overwrites an existing env file and never
# touches an existing database or uploads directory.
#
# Optional one-time data seeding is at the bottom, opt-in and off by default.
#
# See docs/DEPLOY.md.

set -euo pipefail

INSTANCE="${1:-p1}"

if [[ ! "$INSTANCE" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "error: instance name must be lowercase alphanumeric with dashes, got '$INSTANCE'" >&2
  exit 2
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: must run as root (try: sudo $0 $INSTANCE)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="hermes"
SERVICE_GROUP="hermes"
CODE_DIR="/srv/hermes/${INSTANCE}"
DATA_DIR="/var/lib/hermes/${INSTANCE}"
ENV_DIR="/etc/hermes"
ENV_FILE="${ENV_DIR}/${INSTANCE}.env"
UNIT_SRC="${REPO_ROOT}/deploy/hermes-be@.service"
UNIT_DEST="/etc/systemd/system/hermes-be@.service"
ENV_EXAMPLE="${REPO_ROOT}/deploy/hermes.env.example"

step() { printf '\n==> %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }

cat <<BANNER
hermes-be host setup
  instance      ${INSTANCE}
  service user  ${SERVICE_USER}:${SERVICE_GROUP}
  code          ${CODE_DIR}/hermes-be
  data          ${DATA_DIR} (hermes.db, files/)
  environment   ${ENV_FILE}
  unit          ${UNIT_DEST}, enabled as hermes-be@${INSTANCE}
BANNER

for required in "$UNIT_SRC" "$ENV_EXAMPLE"; do
  if [[ ! -f "$required" ]]; then
    echo "error: missing $required -- run this from a hermes-be checkout" >&2
    exit 1
  fi
done

step "Service group and user"
if getent group "$SERVICE_GROUP" >/dev/null; then
  info "group ${SERVICE_GROUP} already exists"
else
  info "creating system group ${SERVICE_GROUP}"
  groupadd --system "$SERVICE_GROUP"
fi

if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  info "user ${SERVICE_USER} already exists"
else
  info "creating system user ${SERVICE_USER} (no login shell, no home)"
  useradd --system --gid "$SERVICE_GROUP" --home-dir /nonexistent \
    --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

step "Directories"
info "creating ${CODE_DIR} and ${DATA_DIR}/files"
install -d -o root -g root -m 0755 /srv/hermes /var/lib/hermes
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 "$CODE_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$DATA_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$DATA_DIR/files"
install -d -o root -g root -m 0755 "$ENV_DIR"

step "Environment file"
if [[ -f "$ENV_FILE" ]]; then
  info "${ENV_FILE} already exists, leaving it alone"
else
  info "installing ${ENV_FILE} from deploy/hermes.env.example"
  # The example ships p1's values; rewrite them for this instance.
  sed "s#/var/lib/hermes/p1#${DATA_DIR}#g" "$ENV_EXAMPLE" >"$ENV_FILE"
  chown root:"$SERVICE_GROUP" "$ENV_FILE"
  # Readable by the service, not world-readable: it is where secrets would go.
  chmod 0640 "$ENV_FILE"
  info "review PORT and the rest before starting: ${ENV_FILE}"
fi

step "Systemd template unit"
info "installing ${UNIT_DEST}"
install -o root -g root -m 0644 "$UNIT_SRC" "$UNIT_DEST"
systemctl daemon-reload
info "enabling hermes-be@${INSTANCE} at boot"
systemctl enable "hermes-be@${INSTANCE}"

# ---------------------------------------------------------------------------
# OPTIONAL, ONE TIME: seed this instance from an existing database
# ---------------------------------------------------------------------------
# Set HERMES_SEED_FROM to a directory holding an existing hermes.db and files/
# and they are copied in, but only where nothing exists yet. This is the
# documented one-time move of a development database onto the host:
#
#   sudo HERMES_SEED_FROM=/home/ai/Workspace/hermes-be/data \
#     ./scripts/setup-host.sh p1
#
# NOTE: data/hermes.db does not currently exist in the dev workspace (only
# data/files/), so on a fresh install this is a no-op and the schema is created
# on the first start of the service. Leave HERMES_SEED_FROM unset in that case.
# ---------------------------------------------------------------------------
if [[ -n "${HERMES_SEED_FROM:-}" ]]; then
  step "Optional seeding from ${HERMES_SEED_FROM}"

  if [[ ! -d "$HERMES_SEED_FROM" ]]; then
    echo "error: HERMES_SEED_FROM=${HERMES_SEED_FROM} is not a directory" >&2
    exit 1
  fi

  if [[ -f "${HERMES_SEED_FROM}/hermes.db" ]]; then
    if [[ -e "${DATA_DIR}/hermes.db" ]]; then
      info "${DATA_DIR}/hermes.db already exists, refusing to overwrite it"
    else
      info "copying hermes.db"
      install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0640 \
        "${HERMES_SEED_FROM}/hermes.db" "${DATA_DIR}/hermes.db"
    fi
  else
    info "no hermes.db in ${HERMES_SEED_FROM}, nothing to copy"
  fi

  if [[ -d "${HERMES_SEED_FROM}/files" ]]; then
    info "copying uploads that are not already present"
    cp -rn "${HERMES_SEED_FROM}/files/." "${DATA_DIR}/files/" 2>/dev/null || true
    chown -R "$SERVICE_USER":"$SERVICE_GROUP" "${DATA_DIR}/files"
  else
    info "no files/ in ${HERMES_SEED_FROM}, nothing to copy"
  fi
fi

cat <<DONE

Done. hermes-be@${INSTANCE} is enabled but not started, because there is no
code in ${CODE_DIR}/hermes-be yet.

Next:
  1. review ${ENV_FILE}
  2. deploy a tag:  ./scripts/deploy.sh ${INSTANCE} v0.3.0
  3. check it:      systemctl status hermes-be@${INSTANCE}
                    journalctl -u hermes-be@${INSTANCE} -f
DONE
