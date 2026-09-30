#!/usr/bin/env bash
#
# Deploy a hermes-be tag to one instance.
#
#   sudo ./scripts/deploy.sh <instance> <tag>
#   sudo ./scripts/deploy.sh p1 v0.4.0
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
  tag        git tag to deploy, e.g. v0.4.0

environment:
  HERMES_REPO_URL         git remote to fetch from
                          (default https://github.com/ahyibrahim/hermes-be.git)
  HERMES_HEALTH_TIMEOUT   seconds to wait for /health (default 90)
  HERMES_FE_REPO_URL      hermes-fe remote to build the web app from
                          (default https://github.com/ahyibrahim/hermes-fe.git).
                          The same tag is checked out and verified.
  HERMES_WEB_BUNDLE       optional path to a SvelteKit apps/web/build directory,
                          or a .tar.gz of it. When set, skips the hermes-fe
                          build and installs this tree instead.
  HERMES_ALLOWED_SIGNERS  SSH allowed-signers file used to verify tags
                          (default /etc/hermes/allowed_signers). Required for
                          v0.29.0 and newer.
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
FE_REPO_URL="${HERMES_FE_REPO_URL:-https://github.com/ahyibrahim/hermes-fe.git}"
CHECKOUT="/srv/hermes/${INSTANCE}/hermes-be"
FE_CHECKOUT="/srv/hermes/${INSTANCE}/hermes-fe"
ALLOWED_SIGNERS="${HERMES_ALLOWED_SIGNERS:-/etc/hermes/allowed_signers}"
ENV_FILE="/etc/hermes/${INSTANCE}.env"
UNIT="hermes-be@${INSTANCE}"
HEALTH_TIMEOUT="${HERMES_HEALTH_TIMEOUT:-90}"

DEPLOYED_COMMIT=""
DEPLOYED_VERSION=""
FE_BUNDLE_DIR=""

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

# npm must run in CHECKOUT. This script is invoked from the operator's working
# tree (or, later, a runner workspace). The hermes user cannot read /home/ai
# (mode 750), so a bare `npm ci` there fails with "no package-lock.json" even
# though the production checkout has one. git already uses -C; npm gets --prefix.
npm_in_checkout() {
  as_service_user env HOME="$CHECKOUT" npm_config_cache="${CHECKOUT}/.npm-cache" \
    npm --prefix "$CHECKOUT" "$@"
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

# v0.29.0 and newer tags, including release candidates, must be SSH-signed.
# Older tags stay deployable unsigned so a rollback still works.
tag_needs_signature() {
  local ver="${1#v}"
  ver="${ver%%-*}"
  local major=0 minor=0 patch=0
  IFS=. read -r major minor patch <<<"$ver"
  major="${major:-0}"
  minor="${minor:-0}"
  patch="${patch:-0}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]] || return 0
  if (( major > 0 || minor > 29 || (minor == 29 && patch >= 0) )); then
    return 0
  fi
  return 1
}

# Refuse when this checkout already has the tag pointing at a different object.
# Git runs as the service user so a root-owned script can read the checkout.
assert_tag_unmoved() {
  local repo="$1" url="$2" tag="$3"
  local remote local_sha
  remote="$(as_service_user git -C "$repo" ls-remote origin "refs/tags/${tag}")"
  remote="$(printf '%s\n' "$remote" | awk -v ref="refs/tags/${tag}" '$2 == ref { print $1; exit }')"
  [[ -n "$remote" ]] || fail "tag ${tag} does not exist on ${url}. Push the tag first."
  local_sha="$(as_service_user git -C "$repo" rev-parse --verify --quiet "refs/tags/${tag}" || true)"
  if [[ -n "$local_sha" && "$local_sha" != "$remote" ]]; then
    fail "tag ${tag} moved (${local_sha} -> ${remote}); refusing to deploy it"
  fi
}

verify_release_tag() {
  local repo="$1" tag="$2"
  if ! tag_needs_signature "$tag"; then
    info "tag ${tag} predates signed deploys; signature not required"
    return 0
  fi
  [[ -f "$ALLOWED_SIGNERS" ]] ||
    fail "allowed signers file ${ALLOWED_SIGNERS} is missing; cannot verify ${tag}"
  if ! as_service_user git -C "$repo" -c gpg.format=ssh \
    -c "gpg.ssh.allowedSignersFile=${ALLOWED_SIGNERS}" verify-tag "$tag"; then
    fail "tag ${tag} failed signature verification"
  fi
  info "tag ${tag} signature verified"
}

fetch_tag() {
  local repo="$1" tag="$2"
  as_service_user git -C "$repo" fetch --quiet origin "refs/tags/${tag}:refs/tags/${tag}"
}

prepare_checkout() {
  step "Checking out ${TAG} into ${CHECKOUT}"

  if [[ ! -d "${CHECKOUT}/.git" ]]; then
    info "no checkout yet, cloning ${REPO_URL}"
    install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 "$(dirname "$CHECKOUT")"
    as_service_user git clone --quiet "$REPO_URL" "$CHECKOUT"
  fi

  assert_tag_unmoved "$CHECKOUT" "$REPO_URL" "$TAG" >/dev/null
  fetch_tag "$CHECKOUT" "$TAG"
  verify_release_tag "$CHECKOUT" "$TAG"

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
  npm_in_checkout ci --no-audit --no-fund
}

build_backend() {
  step "Building"
  npm_in_checkout run build
  [[ -f "${CHECKOUT}/dist/server.js" ]] || fail "build produced no dist/server.js"
}

# Copies a built web tree into a root-only temp directory, rejects symlinks,
# checks SHA-256, then replaces HERMES_WEB_DIR.
stage_web_bundle() {
  local bundle="$1" web_dir="$2"
  local staging sums link
  staging="$(mktemp -d /root/hermes-web.XXXXXX)"
  chmod 0700 "$staging"

  if [[ -d "$bundle" ]]; then
    tar -C "$bundle" -cf - . | tar -C "$staging" -xf -
  elif [[ -f "$bundle" && ( "$bundle" == *.tar.gz || "$bundle" == *.tgz ) ]]; then
    tar -xzf "$bundle" -C "$staging"
  else
    rm -rf "$staging"
    fail "web bundle ${bundle} must be a directory or a .tar.gz"
  fi

  if [[ ! -f "${staging}/index.html" ]]; then
    local -a kids=()
    local child
    for child in "${staging}"/*; do
      [[ -e "$child" ]] || continue
      kids+=("$child")
    done
    if [[ ${#kids[@]} -eq 1 && -d "${kids[0]}" && -f "${kids[0]}/index.html" ]]; then
      info "using nested $(basename "${kids[0]}")/ as the bundle root"
      local inner="${kids[0]}"
      local flat
      flat="$(mktemp -d /root/hermes-web.XXXXXX)"
      chmod 0700 "$flat"
      tar -C "$inner" -cf - . | tar -C "$flat" -xf -
      rm -rf "$staging"
      staging="$flat"
    fi
  fi

  if [[ ! -f "${staging}/index.html" ]]; then
    rm -rf "$staging"
    fail "web bundle has no index.html; expected a SvelteKit apps/web/build directory"
  fi

  while IFS= read -r link; do
    rm -rf "$staging"
    fail "web bundle contains a symlink (${link}); refusing to install it"
  done < <(find "$staging" -type l)

  sums="$(mktemp /root/hermes-web.XXXXXX.sha256)"
  (cd "$staging" && find . -type f -print0 | sort -z | xargs -0 sha256sum) >"$sums"
  if ! (cd "$staging" && sha256sum -c "$sums" >/dev/null); then
    rm -rf "$staging"
    rm -f "$sums"
    fail "web bundle checksum did not match the staged files"
  fi
  info "web checksum $(sha256sum "$sums" | awk '{ print $1 }')"

  install -d -o root -g root -m 0755 "$(dirname "$web_dir")"
  install -d -o root -g root -m 0755 "$web_dir"
  find "$web_dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -a --no-preserve=ownership "$staging"/. "$web_dir"/
  chown -R root:root "$web_dir"
  chmod -R u=rwX,go=rX "$web_dir"
  rm -rf "$staging"
  rm -f "$sums"
  info "web bundle installed at ${web_dir} (root-owned, read-only to ${SERVICE_USER})"
}

build_fe_bundle() {
  step "Building hermes-fe ${TAG}"

  if [[ ! -d "${FE_CHECKOUT}/.git" ]]; then
    info "no hermes-fe checkout yet, cloning ${FE_REPO_URL}"
    install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 "$(dirname "$FE_CHECKOUT")"
    as_service_user git clone --quiet "$FE_REPO_URL" "$FE_CHECKOUT"
  fi

  assert_tag_unmoved "$FE_CHECKOUT" "$FE_REPO_URL" "$TAG" >/dev/null
  fetch_tag "$FE_CHECKOUT" "$TAG"
  verify_release_tag "$FE_CHECKOUT" "$TAG"
  as_service_user git -C "$FE_CHECKOUT" checkout --quiet --detach "refs/tags/${TAG}"
  as_service_user git -C "$FE_CHECKOUT" clean -qfd

  as_service_user env HOME="$FE_CHECKOUT" npm_config_cache="${FE_CHECKOUT}/.npm-cache" \
    npm --prefix "$FE_CHECKOUT" ci --no-audit --no-fund
  as_service_user env HOME="$FE_CHECKOUT" npm_config_cache="${FE_CHECKOUT}/.npm-cache" \
    npm --prefix "$FE_CHECKOUT" run build --workspace @hermes/web
  [[ -f "${FE_CHECKOUT}/apps/web/build/index.html" ]] ||
    fail "hermes-fe build produced no apps/web/build/index.html"
  FE_BUNDLE_DIR="${FE_CHECKOUT}/apps/web/build"
}

install_web_bundle() {
  step "Installing web bundle"

  local web_dir
  web_dir="$(env_file_value HERMES_WEB_DIR)"
  if [[ -z "$web_dir" ]]; then
    info "HERMES_WEB_DIR is unset in ${ENV_FILE}; skipping web bundle (backend-only deploy)"
    return 0
  fi

  local data_dir
  data_dir="$(instance_data_dir)"
  case "${web_dir%/}/" in
    "${data_dir%/}/"*)
      fail "HERMES_WEB_DIR=${web_dir} is inside the data directory ${data_dir}. Set HERMES_WEB_DIR=/srv/hermes/web/${INSTANCE} in ${ENV_FILE}, deploy again, then remove ${web_dir}."
      ;;
  esac
  [[ ! -L "$web_dir" ]] || fail "HERMES_WEB_DIR=${web_dir} is a symlink; refusing to write through it"

  local bundle
  if [[ -n "${HERMES_WEB_BUNDLE:-}" ]]; then
    bundle="$HERMES_WEB_BUNDLE"
    [[ -e "$bundle" ]] || fail "HERMES_WEB_BUNDLE=${bundle} does not exist"
    [[ ! -L "$bundle" ]] || fail "HERMES_WEB_BUNDLE=${bundle} is a symlink; refusing to follow it"
    info "installing operator bundle ${bundle}"
  else
    FE_BUNDLE_DIR=""
    build_fe_bundle
    bundle="$FE_BUNDLE_DIR"
  fi

  stage_web_bundle "$bundle" "$web_dir"
}

instance_data_dir() {
  local db_path
  db_path="$(env_file_value HERMES_DB_PATH)"
  if [[ -n "$db_path" ]]; then
    dirname "$db_path"
  else
    printf '/var/lib/hermes/%s\n' "$INSTANCE"
  fi
}

# The service writes with UMask=0077, but older releases, manual `cp -a`
# backups and the pre-v0.27 deploy script left the database world-readable.
# Session tokens and password hashes live there, so this runs on every deploy.
secure_data_dir() {
  step "Securing the data directory"
  local data_dir
  data_dir="$(instance_data_dir)"
  [[ -d "$data_dir" ]] || { info "${data_dir} does not exist yet; nothing to do"; return 0; }
  [[ ! -L "$data_dir" ]] || fail "data directory ${data_dir} is a symlink; refusing to chmod through it"

  local db_name files_dir
  db_name="$(basename "$(env_file_value HERMES_DB_PATH)")"
  db_name="${db_name:-hermes.db}"
  files_dir="$(env_file_value HERMES_FILES_DIR)"
  files_dir="${files_dir:-${data_dir}/files}"

  chown "$SERVICE_USER:$SERVICE_GROUP" "$data_dir"
  chmod 0750 "$data_dir"
  # The glob also catches -wal, -shm and hand-made .pre-vX.Y.Z backups.
  find "$data_dir" -maxdepth 1 -type f -name "${db_name}*" -exec chmod 0600 {} +
  if [[ -d "$files_dir" && ! -L "$files_dir" ]]; then
    chmod 0750 "$files_dir"
    find "$files_dir" -maxdepth 1 -type f -exec chmod 0600 {} +
  fi
  info "${data_dir} is 0750; ${db_name}* and uploads are 0600"
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
  secure_data_dir
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
