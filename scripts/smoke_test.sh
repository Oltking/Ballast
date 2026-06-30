#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# smoke_test.sh — automated smoke test of the deployed Ballast custodian
# backend. Hits the reachable surface (health, public book, passport anchor,
# auth challenge) and — if PROVER_TOKEN is set — the prover paths (reconcile,
# book-leaves). Read-only / idempotent; reconcile is a pure function of chain
# state, so it's safe to run repeatedly.
#
# Usage:
#   bash scripts/smoke_test.sh https://ballast-gamma.vercel.app
#   BASE_URL=https://ballast-gamma.vercel.app bash scripts/smoke_test.sh
#   BASE_URL=... PROVER_TOKEN=<token> bash scripts/smoke_test.sh   # incl. prover paths
#
# Env / args:
#   BASE_URL       deployed app origin (env or first arg). Required.
#   PROVER_TOKEN   optional — if set, also exercises POST /api/reconcile and
#                  GET /api/book-leaves (the x-prover-token gated paths).
# ---------------------------------------------------------------------------
set -euo pipefail

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# A public, well-formed testnet G... address — used only to prove the auth
# challenge path is wired (we never sign or submit anything).
SAMPLE_ADDR="GCPBZLNW2F2X3KQEILWRJRFBNSHFKWNY6GFSBCB4I624D2KVRY6P2JLQ"

BASE_URL="${1:-${BASE_URL:-}}"
[ -n "$BASE_URL" ] || die "set BASE_URL (env or first arg), e.g. https://ballast-gamma.vercel.app"
BASE_URL="${BASE_URL%/}"   # strip a trailing slash

command -v curl >/dev/null || die "curl not found."
HAVE_JQ=0; command -v jq >/dev/null && HAVE_JQ=1

# field <json> <key>  -> value for a top-level key (jq if present, else grep/sed).
field() {
  if [ "$HAVE_JQ" = 1 ]; then
    printf '%s' "$1" | jq -r ".${2} // \"-\""
  else
    printf '%s' "$1" \
      | grep -o "\"${2}\"[[:space:]]*:[[:space:]]*\(\"[^\"]*\"\|[0-9.eE+-]*\|true\|false\|null\)" \
      | head -n1 | sed -E 's/.*:[[:space:]]*//; s/^"//; s/"$//'
  fi
}

get()  { curl -fsS "$BASE_URL$1"; }
post() { curl -fsS -X POST "$BASE_URL$1" -H "x-prover-token: ${PROVER_TOKEN}"; }

bold "=== Ballast backend smoke test ==="
echo "base_url=$BASE_URL  jq=$([ "$HAVE_JQ" = 1 ] && echo yes || echo no)"
[ -n "${PROVER_TOKEN:-}" ] && echo "prover_token=set" || echo "prover_token=unset (prover paths skipped)"

# ---- 1. health --------------------------------------------------------------
bold "--- GET /api/health ---"
HEALTH="$(get /api/health)" || die "backend unreachable at $BASE_URL/api/health"
echo "durableStore       = $(field "$HEALTH" durableStore)"
echo "operatorConfigured = $(field "$HEALTH" operatorConfigured)"
echo "proverTokenSet     = $(field "$HEALTH" proverTokenSet)"
echo "operator           = $(field "$HEALTH" operator)"

# ---- 2. public book ---------------------------------------------------------
bold "--- GET /api/book ---"
BOOK="$(get /api/book)" || die "GET /api/book failed"
echo "liabilitiesRoot    = $(field "$BOOK" liabilitiesRoot)"
echo "total (L)          = $(field "$BOOK" total)"
echo "count              = $(field "$BOOK" count)"
echo "reserves           = $(field "$BOOK" reserves)"
echo "netCustodied       = $(field "$BOOK" netCustodied)"

# ---- 3. passport anchor -----------------------------------------------------
bold "--- GET /api/passport/root ---"
PASS="$(get /api/passport/root)" || die "GET /api/passport/root failed"
echo "credit anchor root = $(field "$PASS" root)"
echo "count              = $(field "$PASS" count)"

# ---- 4. auth challenge (proves the wallet-auth path is wired) ----------------
bold "--- GET /api/auth-challenge?address=$SAMPLE_ADDR ---"
CHAL="$(get "/api/auth-challenge?address=$SAMPLE_ADDR")" || die "GET /api/auth-challenge failed"
NONCE="$(field "$CHAL" nonce)"
XDR="$(field "$CHAL" xdr)"
[ -n "$NONCE" ] && [ "$NONCE" != "-" ] || die "auth-challenge returned no nonce"
[ -n "$XDR" ]   && [ "$XDR" != "-" ]   || die "auth-challenge returned no xdr"
echo "nonce              = $NONCE"
echo "xdr                = ${XDR:0:24}… (${#XDR} chars)"

# ---- 5. prover paths (only with PROVER_TOKEN) -------------------------------
PROVER_OK="skipped (no PROVER_TOKEN)"
if [ -n "${PROVER_TOKEN:-}" ]; then
  bold "--- POST /api/reconcile (x-prover-token) ---"
  REC="$(post /api/reconcile)" || die "POST /api/reconcile failed (token wrong?)"
  echo "updated            = $(field "$REC" updated)"
  echo "count              = $(field "$REC" count)"
  echo "total              = $(field "$REC" total)"
  echo "root               = $(field "$REC" root)"

  bold "--- GET /api/book-leaves (x-prover-token) ---"
  LEAVES="$(curl -fsS "$BASE_URL/api/book-leaves" -H "x-prover-token: ${PROVER_TOKEN}")" \
    || die "GET /api/book-leaves failed (token wrong?)"
  echo "leaf count         = $(field "$LEAVES" count)"
  PROVER_OK="ok"
else
  bold "--- prover paths skipped ---"
  echo "set PROVER_TOKEN to also test POST /api/reconcile + GET /api/book-leaves"
fi

# ---- summary ----------------------------------------------------------------
bold "=== PASS ==="
echo "health        : reachable (durableStore=$(field "$HEALTH" durableStore), operatorConfigured=$(field "$HEALTH" operatorConfigured), proverTokenSet=$(field "$HEALTH" proverTokenSet))"
echo "public book   : ok (root=$(field "$BOOK" liabilitiesRoot), count=$(field "$BOOK" count))"
echo "passport root : ok (count=$(field "$PASS" count))"
echo "auth path     : ok (nonce + xdr issued)"
echo "prover paths  : $PROVER_OK"
bold "SMOKE_TEST_DONE"
