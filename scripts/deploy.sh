#!/usr/bin/env bash
#
# Deploy a hermes-be tag to one instance.
#
#   sudo ./scripts/deploy.sh <instance> <tag>
#   sudo ./scripts/deploy.sh p1 v0.3.0
#
# Checks the tag out into /srv/hermes/<instance>/hermes-be, installs, builds,
# restarts hermes-be@<instance> and then polls /health until it reports the
# version and commit that were just deployed.
#
# Needs root: it writes /etc/hermes/<instance>.env and restarts a unit. Run
# scripts/setup-host.sh once first.
#
# In v0.5.0 this script is called by a GitHub Actions job on a self-hosted
# runner instead of by hand. The function seams below are where that release
# adds its two pieces, so the deploy path itself is not rewritten:
#
#   install_web_bundle()  v0.4.0 unpacks the hermes-fe static bundle into
#                         HERMES_WEB_DIR here (with the v0.5.0 download retry).
#   main()                v0.5.0 wraps the deploy in rollback: remember the
#                         currently deployed tag, and on a health-check failure
#                         redeploy it, web asset included.
#
# See docs/DEPLOY.md and docs/adr/0002-deployment-topology.md.

set -euo pipefail

usage() {
  cat >&2 <<USAGE
usage: sudo $0 <instance> <tag>

  instance   systemd template instance, e.g. p1
  tag        git tag to deploy, e.g. v0.3.0

environment:
  HERMES_REPO_URL         git remote to fetch from
                          (default https://github.com/ahyibrahim/hermes-be.git)
  HERMES_HEALTH_TIMEOUT   seconds to wait for /health (default 90)
USAGE
  exit 2
}

if [[ $# -ne 2 ]]; then
  usage
fi

INSTANCE="$1"
TAG="$2"

if [[ ! "$INSTANCE" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "error: instance name must be lowercase alphanumeric with dashes, got '$INSTANCE'" >&2
  exit 2
fi

if [[ ! "$TAG" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "error: tag '$TAG' contains characters that are not allowed" >&2
  exit 2
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: must run as root (try: sudo $0 $INSTANCE $TAG)" >&2
  exit 1
fi

SERVICE_USER="hermes"
SERVICE_GROUP="hermes"
REPO_URL="${HERMES_REPO_URL:-https://github.com/ahyibrahim/hermes-be.git}"
CHECKOUT="/srv/hermes/${INSTANCE}/hermes-be"
ENV_FILE="/etc/hermes/${INSTANCE}.env"
UNIT="hermes-be@${INSTANCE}"
HEALTH_TIMEOUT="${HERMES_HEALTH_TIMEOUT:-90}"

DEPLOYED_COMMIT=""
DEPLOYED_VERSION=""

step() { printf '\n==> %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
fail() {
  printf '\nDEPLOY FAILED: %s\n' "$1" >&2
  exit 1
}

as_service_user() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$SERVICE_USER" -- "$@"
  else
    sudo -u "$SERVICE_USER" -- "$@"
  fi
}

# Reads one variable out of the systemd EnvironmentFile without sourcing it.
env_file_value() {
  local key="$1"
  sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -n 1 | tr -d '"'
}

json_field() {
  local body="$1" key="$2"
  printf '%s' "$body" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1
}

check_prerequisites() {
  step "Checking prerequisites"

  [[ -f "$ENV_FILE" ]] ||
    fail "$ENV_FILE does not exist. Run: sudo ./scripts/setup-host.sh ${INSTANCE}"
  info "environment file ${ENV_FILE}"

  id -u "$SERVICE_USER" >/dev/null 2>&1 ||
    fail "service user ${SERVICE_USER} does not exist. Run scripts/setup-host.sh first."

  systemctl cat "$UNIT" >/dev/null 2>&1 ||
    fail "unit ${UNIT} is not installed. Run scripts/setup-host.sh first."

  for tool in git npm curl systemctl; do
    command -v "$tool" >/dev/null 2>&1 || fail "required command '$tool' not found"
  done

  PORT="$(env_file_value PORT)"
  PORT="${PORT:-3000}"
  info "instance ${INSTANCE} listens on port ${PORT}"
}

prepare_checkout() {
  step "Checking out ${TAG} into ${CHECKOUT}"

  if [[ ! -d "${CHECKOUT}/.git" ]]; then
    info "no checkout yet, cloning ${REPO_URL}"
    install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 "$(dirname "$CHECKOUT")"
    as_service_user git clone --quiet "$REPO_URL" "$CHECKOUT"
  fi

  as_service_user git -C "$CHECKOUT" fetch --quiet --tags --force origin

  as_service_user git -C "$CHECKOUT" rev-parse --verify --quiet "refs/tags/${TAG}^{commit}" >/dev/null ||
    fail "tag ${TAG} does not exist on ${REPO_URL}. Push the tag first."

  # Detached checkout: the production tree tracks a tag, never a branch.
  as_service_user git -C "$CHECKOUT" checkout --quiet --detach "refs/tags/${TAG}"
  as_service_user git -C "$CHECKOUT" clean -qfd

  DEPLOYED_COMMIT="$(as_service_user git -C "$CHECKOUT" rev-parse HEAD)"
  DEPLOYED_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "${CHECKOUT}/package.json" | head -n 1)"

  [[ -n "$DEPLOYED_VERSION" ]] || fail "could not read version from ${CHECKOUT}/package.json"
  info "commit  ${DEPLOYED_COMMIT}"
  info "version ${DEPLOYED_VERSION}"

  if [[ "$TAG" != "v${DEPLOYED_VERSION}" ]]; then
    info "warning: tag ${TAG} does not match package version ${DEPLOYED_VERSION}"
  fi
}

install_dependencies() {
  step "Installing dependencies"
  # npm ci, not `npm ci --omit=dev`: tsc needs the @types packages, which live in
  # devDependencies. HOME and the cache are redirected because the service user
  # deliberately has no home directory.
  as_service_user env HOME="$CHECKOUT" npm_config_cache="${CHECKOUT}/.npm-cache" \
    npm ci --no-audit --no-fund
}

build_backend() {
  step "Building"
  as_service_user env HOME="$CHECKOUT" npm_config_cache="${CHECKOUT}/.npm-cache" \
    npm run build
  [[ -f "${CHECKOUT}/dist/server.js" ]] || fail "build produced no dist/server.js"
}

install_web_bundle() {
  # v0.4.0 seam. The SvelteKit bundle is built in hermes-fe and published as a
  # release asset; this is where it gets downloaded and unpacked into
  # HERMES_WEB_DIR, and where v0.5.0 adds the retry-with-backoff, because the
  # two repos release independently and the asset may still be uploading.
  # Nothing to do until HERMES_WEB_DIR and the @fastify/static mount exist.
  :
}

run_migrations() {
  step "Migrations"
  # There is no separate migrate command by design: migrateSchema() runs on
  # every process start, inside createApp's database handle. So restarting the
  # unit below is the migration step. Every migration up to v0.6.0 is additive
  # (CREATE TABLE IF NOT EXISTS / ADD COLUMN), which is what makes rolling back
  # to the previous tag safe without a restore.
  info "run on service start by migrateSchema(); nothing to do here"
}

write_instance_commit() {
  step "Recording the deployed commit in ${ENV_FILE}"
  # The service reports this on /health. A production checkout may have no .git
  # the service user can read, so the env file is the authoritative answer.
  if grep -q '^[[:space:]]*HERMES_GIT_COMMIT[[:space:]]*=' "$ENV_FILE"; then
    sed -i "s#^[[:space:]]*HERMES_GIT_COMMIT[[:space:]]*=.*#HERMES_GIT_COMMIT=${DEPLOYED_COMMIT}#" \
      "$ENV_FILE"
  else
    printf 'HERMES_GIT_COMMIT=%s\n' "$DEPLOYED_COMMIT" >>"$ENV_FILE"
  fi
  info "HERMES_GIT_COMMIT=${DEPLOYED_COMMIT}"
}

restart_service() {
  step "Restarting ${UNIT}"
  systemctl restart "$UNIT"
}

# Polls until /health reports the version and commit that were just deployed,
# which is what makes a deploy verifiable rather than merely attempted.
wait_for_health() {
  step "Waiting for /health to report ${DEPLOYED_VERSION} @ ${DEPLOYED_COMMIT:0:12}"

  local url="http://127.0.0.1:${PORT}/health"
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  local body version commit last=""

  while ((SECONDS < deadline)); do
    if body="$(curl --silent --show-error --max-time 5 "$url" 2>/dev/null)"; then
      version="$(json_field "$body" version)"
      commit="$(json_field "$body" commit)"
      last="version=${version:-?} commit=${commit:-?}"

      if [[ "$version" == "$DEPLOYED_VERSION" ]] && commit_matches "$commit"; then
        info "healthy: ${last}"
        return 0
      fi
    else
      last="no response from ${url}"
    fi

    sleep 2
  done

  printf '\n' >&2
  echo "last seen: ${last}" >&2
  echo "expected:  version=${DEPLOYED_VERSION} commit=${DEPLOYED_COMMIT}" >&2
  echo "diagnose:  systemctl status ${UNIT}" >&2
  echo "           journalctl -u ${UNIT} -n 50 --no-pager" >&2
  fail "${UNIT} did not report the deployed build within ${HEALTH_TIMEOUT}s"
}

# Tolerates a short sha in either direction, so a hand-edited env file with an
# abbreviated commit still verifies.
commit_matches() {
  local reported="$1"
  [[ -n "$reported" ]] || return 1
  [[ "$DEPLOYED_COMMIT" == "$reported"* || "$reported" == "$DEPLOYED_COMMIT"* ]]
}

main() {
  check_prerequisites
  prepare_checkout
  install_dependencies
  build_backend
  install_web_bundle
  run_migrations
  write_instance_commit
  restart_service
  # v0.5.0: on failure here, redeploy the previously deployed tag (backend and
  # web asset together) instead of exiting.
  wait_for_health

  cat <<DONE

Deployed ${TAG} to ${INSTANCE}.
  version  ${DEPLOYED_VERSION}
  commit   ${DEPLOYED_COMMIT}
  health   http://127.0.0.1:${PORT}/health
  logs     journalctl -u ${UNIT} -f
DONE
}

main "$@"
