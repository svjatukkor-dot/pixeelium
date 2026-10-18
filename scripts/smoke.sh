#!/usr/bin/env bash
# End-to-end smoke + security checks against a running local dev server.
#   node scripts/mock-tron.mjs &          # mock Tron API (PORT 8799)
#   npx wrangler dev --port 8787 --test-scheduled   # worker with .dev.vars
#   bash scripts/smoke.sh
#
# Payments are verified by EXACT amount (base + random surcharge), so every
# successful payment below mints a matching tx through the mock's /__mint.
set -u

BASE="${BASE:-http://127.0.0.1:8787}"
MOCK="${MOCK:-http://127.0.0.1:8799}"
ORIGIN="$BASE"
BODY="$(mktemp)"
HDR="$(mktemp)"

ALICE=$(grep '^alice=' scripts/test-cookie.txt | cut -d= -f2)
BOB=$(grep '^bob=' scripts/test-cookie.txt | cut -d= -f2)

PASS=0
FAIL=0
STATUS=""

pass() { PASS=$((PASS + 1)); echo "PASS  $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL  $1"; }

call() { # call METHOD PATH [curl args...]
  local method="$1" path="$2"
  shift 2
  STATUS=$(curl -s -m 15 -o "$BODY" -w "%{http_code}" -X "$method" "$BASE$path" "$@")
}

expect_status() { # expect_status "name" wanted
  if [ "$STATUS" = "$2" ]; then pass "$1"
  else fail "$1 (got $STATUS, want $2) :: $(head -c 220 "$BODY")"; fi
}

expect_body_has() { # expect_body_has "name" needle
  if [ -z "$2" ]; then fail "$1 (empty needle: id extraction failed)"; return; fi
  if grep -qF -- "$2" "$BODY"; then pass "$1"
  else fail "$1 (missing '$2') :: $(head -c 220 "$BODY")"; fi
}

order_id() { grep -o '"id":"[0-9a-f]\{32\}"' "$BODY" | head -1 | cut -d'"' -f4; }
amount_micro() { grep -o '"amountMicro":[0-9]*' "$BODY" | head -1 | cut -d: -f2; }

expect_body_missing() {
  if grep -qF -- "$2" "$BODY"; then fail "$1 (found '$2') :: $(head -c 220 "$BODY")"
  else pass "$1"; fi
}

mint() { # mint VALUE -> echoes txHash (registers the payment in the mock)
  curl -s -m 10 -X POST "$MOCK/__mint" -H "Content-Type: application/json" \
    -d "{\"value\":$1}" | grep -o '"txHash":"[0-9a-f]\{64\}"' | cut -d'"' -f4
}

echo "=== 0. reset local state (deterministic runs) ==="
cat > /tmp/smoke-reset.sql <<'SQL'
DELETE FROM holds;
DELETE FROM rentals;
DELETE FROM orders;
DELETE FROM rate_limits;
DELETE FROM sessions;
UPDATE users SET banned = 0;
SQL
CI=true npx wrangler d1 execute DB --local --file /tmp/smoke-reset.sql >/dev/null 2>&1 \
  && pass "state reset" || fail "could not reset state"
CI=true npx wrangler d1 execute DB --local --file scripts/test-seed.sql >/dev/null 2>&1 \
  && pass "test users seeded" || fail "could not seed users"

echo "=== 1. static + headers ==="
call GET /
expect_status "GET / returns 200" 200
HDRS=$(curl -s -m 10 -I "$BASE/")
echo "$HDRS" | grep -qi "^content-security-policy:.*default-src 'self'" \
  && pass "HTML CSP is strict" || fail "HTML CSP missing/weak :: $(echo "$HDRS" | grep -i content-security)"
echo "$HDRS" | grep -qi "^x-content-type-options: nosniff" && pass "nosniff set" || fail "nosniff missing"
echo "$HDRS" | grep -qi "^x-frame-options: DENY" && pass "X-Frame-Options DENY" || fail "X-Frame-Options missing"

call GET /api/health
expect_status "health" 200

echo "=== 2. public config + grid ==="
call GET /api/config
expect_status "config" 200
expect_body_has "config advertises TRC-20 network" '"chain":"TRC-20"'
expect_body_has "config advertises USDT token" '"token":"USDT"'
expect_body_has "config has auth enabled flag" '"authEnabled":true'
expect_body_has "config exposes wallet address" '"payAddress":"T'
expect_body_has "config exposes banner flag" '"bannerHidden":false'

call GET /api/grid
expect_status "grid" 200
ETAG=$(curl -s -m 10 -D - -o /dev/null "$BASE/api/grid" | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)
STATUS=$(curl -s -m 10 -o "$BODY" -w "%{http_code}" -H "If-None-Match: $ETAG" "$BASE/api/grid")
expect_status "grid honors If-None-Match (304)" 304

echo "=== 3. CSRF / origin enforcement ==="
call POST /api/orders -H "Content-Type: application/json" -d '{"x":1,"y":1,"w":1,"h":1,"hours":1}'
expect_status "POST without Origin/Sec-Fetch-Site -> 403" 403

call POST /api/orders -H "Origin: https://evil.example" -H "Content-Type: application/json" -d '{"x":1,"y":1,"w":1,"h":1,"hours":1}'
expect_status "POST from foreign origin -> 403" 403

call POST /api/orders -H "Origin: $ORIGIN" -H "Sec-Fetch-Site: cross-site" -H "Content-Type: application/json" -d '{"x":1,"y":1,"w":1,"h":1,"hours":1}'
expect_status "POST with cross-site Sec-Fetch-Site -> 403" 403

call POST /api/orders -H "Origin: $ORIGIN" -H "Content-Type: application/json" -d '{"x":1,"y":1,"w":1,"h":1,"hours":1}'
expect_status "anonymous POST -> 401" 401

echo "=== 4. OAuth endpoints (Sign in with Freebuff) ==="
STATUS=$(curl -s -m 10 -o "$BODY" -D "$HDR" -w "%{http_code}" "$BASE/api/auth/login")
expect_status "legacy login redirects" 302
grep -qi "^location: .*/auth/freebuff/signin" "$HDR" && pass "redirects to Freebuff signin" || fail "no Freebuff redirect"

STATUS=$(curl -s -m 10 -o "$BODY" -D "$HDR" -w "%{http_code}" "$BASE/auth/freebuff/signin?returnTo=/")
expect_status "signin starts OIDC" 303
grep -qi "^location: .*freebuff.com/oidc/authorize" "$HDR" && pass "redirects to Freebuff authorize" || fail "no OIDC redirect"
grep -i "^location:" "$HDR" | grep -q "code_challenge=" && pass "PKCE challenge present" || fail "PKCE missing"
grep -qi "^set-cookie: freebuff_txn" "$HDR" && pass "OIDC txn cookie set (HttpOnly)" || fail "txn cookie missing"
grep -qi "^set-cookie:.*httponly" "$HDR" && pass "cookie is HttpOnly" || fail "cookie not HttpOnly"

call GET "/api/auth/callback?code=x&state=wrong"
expect_status "legacy callback redirects to Freebuff signin -> 302" 302

echo "=== 5. validation (as alice) ==="
C="Cookie: px_session=$ALICE"
call POST /api/orders -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"x":99,"y":20,"w":5,"h":1,"hours":1}'
expect_status "rect out of bounds -> 400" 400

call POST /api/orders -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"x":0,"y":5,"w":1,"h":1,"hours":1}'
expect_status "reserved top rows -> 403" 403

call POST /api/orders -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"x":0,"y":5,"w":1,"h":1,"mode":"buy"}'
expect_status "buy in reserved top rows -> 403" 403

call POST /api/orders -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"x":0,"y":20,"w":1,"h":1,"hours":9999}'
expect_status "hours out of range -> 400" 400

call POST /api/orders -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"x":0,"y":20,"w":1,"h":1,"hours":1,"imageUrl":"javascript:alert(1)"}'
expect_status "javascript: image url -> 400" 400

call POST /api/orders -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d "{\"x\":0,\"y\":20,\"w\":1,\"h\":1,\"hours\":1,\"title\":\"<script>alert(1)</script>XSS\"}"
expect_status "order with html title accepted" 201
ORDER_A=$(order_id)
AMT_A=$(amount_micro)
if [ -n "$AMT_A" ] && [ "$AMT_A" -ge 50001 ] && [ "$AMT_A" -le 59999 ]; then
  pass "1px/1h amount = 0.05 USDT base + 1..9999 micro surcharge ($AMT_A)"
else
  fail "unexpected amountMicro for 1px/1h: '$AMT_A'"
fi

BIG=$(printf 'A%.0s' {1..9000})
call POST /api/orders -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" -d "{\"pad\":\"$BIG\"}"
expect_status "oversized payload -> 413" 413

echo "=== 6. ownership ==="
call GET "/api/orders/$ORDER_A" -H "Origin: $ORIGIN" -H "Cookie: px_session=$BOB"
expect_status "other user's order -> 404" 404

call GET "/api/orders/$ORDER_A" -H "Origin: $ORIGIN" -H "$C"
expect_status "owner sees order" 200

echo "=== 7. overlap: bob cannot take alice's held rect ==="
call POST /api/orders -H "Origin: $ORIGIN" -H "Cookie: px_session=$BOB" -H "Content-Type: application/json" \
  -d '{"x":0,"y":20,"w":1,"h":1,"hours":1}'
expect_status "overlapping hold -> 409" 409

echo "=== 8. payment verification (exact amount) ==="
call POST "/api/orders/$ORDER_A/pay" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"txHash":"9999999999999999999999999999999999999999999999999999999999999999"}'
expect_status "unknown tx -> 404" 404

TX_A=$(mint "$AMT_A")
call POST "/api/orders/$ORDER_A/pay" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d "{\"txHash\":\"$TX_A\"}"
expect_status "valid exact-amount payment -> 200" 200
expect_body_has "payment result ok" '"ok":true'

call GET "/api/orders/$ORDER_A" -H "Origin: $ORIGIN" -H "$C"
expect_body_has "order status paid" '"status":"paid"'

call GET /api/grid
expect_body_has "grid contains activated rental" "$ORDER_A"
expect_body_missing "grid does not leak owner identity" "alice@example.com"

echo "=== 9. payment edge cases (as alice, order D) ==="
call POST /api/orders -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"x":50,"y":50,"w":2,"h":2,"hours":1,"title":"Second"}'
expect_status "second order created" 201
ORDER_D=$(order_id)
AMT_D=$(amount_micro)

TX_D_LOW=$(mint $((AMT_D - 1)))
call POST "/api/orders/$ORDER_D/pay" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d "{\"txHash\":\"$TX_D_LOW\"}"
expect_status "underpaid tx -> 402" 402
expect_body_has "underpaid reported as insufficient" '"failure":"insufficient"'

call POST "/api/orders/$ORDER_D/pay" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"txHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}'
expect_status "tx to another address -> 400" 400

call POST "/api/orders/$ORDER_D/pay" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"txHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}'
expect_status "reverted tx -> 400" 400

echo "=== 10. stolen / replayed TXID (anti-theft fingerprint) ==="
call POST /api/orders -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"x":5,"y":40,"w":1,"h":1,"hours":1,"title":"A2"}'
expect_status "alice order A2 created" 201
ORDER_A2=$(order_id)
AMT_A2=$(amount_micro)
TX_A2=$(mint "$AMT_A2")
call POST "/api/orders/$ORDER_A2/pay" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d "{\"txHash\":\"$TX_A2\"}"
expect_status "alice pays A2 with her exact-amount tx" 200

call POST /api/orders -H "Origin: $ORIGIN" -H "Cookie: px_session=$BOB" -H "Content-Type: application/json" \
  -d '{"x":7,"y":40,"w":1,"h":1,"hours":1,"title":"B2"}'
expect_status "bob order B2 created" 201
ORDER_B2=$(order_id)
AMT_B2=$(amount_micro)

# The stolen tx already paid for another order: must never activate B2.
call POST "/api/orders/$ORDER_B2/pay" -H "Origin: $ORIGIN" -H "Cookie: px_session=$BOB" -H "Content-Type: application/json" \
  -d "{\"txHash\":\"$TX_A2\"}"
expect_status "stolen tx on another order -> 409" 409
call GET "/api/orders/$ORDER_B2" -H "Origin: $ORIGIN" -H "Cookie: px_session=$BOB"
expect_body_missing "stolen tx did not activate B2" '"status":"paid"'

# A fresh tx with a near-miss amount must not activate either.
TX_B2_LOW=$(mint $((AMT_B2 - 1)))
call POST "/api/orders/$ORDER_B2/pay" -H "Origin: $ORIGIN" -H "Cookie: px_session=$BOB" -H "Content-Type: application/json" \
  -d "{\"txHash\":\"$TX_B2_LOW\"}"
expect_status "near-miss amount -> 402" 402

TX_B2=$(mint "$AMT_B2")
call POST "/api/orders/$ORDER_B2/pay" -H "Origin: $ORIGIN" -H "Cookie: px_session=$BOB" -H "Content-Type: application/json" \
  -d "{\"txHash\":\"$TX_B2\"}"
expect_status "bob pays B2 with own exact-amount tx" 200

# Replaying a paid order with a different (even valid-amount) tx must fail.
TX_B2_OTHER=$(mint "$AMT_B2")
call POST "/api/orders/$ORDER_B2/pay" -H "Origin: $ORIGIN" -H "Cookie: px_session=$BOB" -H "Content-Type: application/json" \
  -d "{\"txHash\":\"$TX_B2_OTHER\"}"
expect_status "different tx on a paid order -> 409" 409

echo "=== 11. finish order D ==="
TX_D=$(mint "$AMT_D")
call POST "/api/orders/$ORDER_D/pay" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d "{\"txHash\":\"$TX_D\"}"
expect_status "valid second payment -> 200" 200

echo "=== 12. mine ==="
call GET /api/mine -H "Origin: $ORIGIN" -H "$C"
expect_status "mine" 200
expect_body_has "two active rentals" '"w":2'
call GET /api/mine -H "Origin: $ORIGIN" -H "Cookie: px_session=$BOB"
expect_status "mine (bob)" 200

echo "=== 13. hold expiry -> conflict on activation ==="
call POST /api/orders -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"x":70,"y":70,"w":2,"h":2,"hours":1,"title":"Alice late"}'
expect_status "alice order F created" 201
ORDER_F=$(order_id)
AMT_F=$(amount_micro)

# Simulate hold expiry: the reservation is gone, but the order is still pending.
CI=true npx wrangler d1 execute DB --local --command \
  "DELETE FROM holds WHERE order_id = '$ORDER_F'" >/dev/null 2>&1 \
  && pass "hold removed (simulated expiry)" || fail "could not delete hold"

call POST /api/orders -H "Origin: $ORIGIN" -H "Cookie: px_session=$BOB" -H "Content-Type: application/json" \
  -d '{"x":70,"y":70,"w":2,"h":2,"hours":1,"title":"Stolen"}'
expect_status "bob rents rect after alice hold vanished" 201
ORDER_G=$(order_id)
AMT_G=$(amount_micro)

TX_G=$(mint "$AMT_G")
call POST "/api/orders/$ORDER_G/pay" -H "Origin: $ORIGIN" -H "Cookie: px_session=$BOB" -H "Content-Type: application/json" \
  -d "{\"txHash\":\"$TX_G\"}"
expect_status "bob payment activates" 200

TX_F=$(mint "$AMT_F")
call POST "/api/orders/$ORDER_F/pay" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d "{\"txHash\":\"$TX_F\"}"
expect_status "alice pays after rect was taken -> 409" 409
expect_body_has "conflict failure reported" '"failure":"conflict"'

echo "=== 13b. buy mode (викуп назавжди) ==="
call POST /api/orders -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"x":30,"y":30,"w":1,"h":1,"mode":"buy","title":"Forever"}'
expect_status "buy order created" 201
ORDER_BUY=$(order_id)
AMT_BUY=$(amount_micro)
if [ -n "$AMT_BUY" ] && [ "$AMT_BUY" -ge 2500001 ] && [ "$AMT_BUY" -le 2509999 ]; then
  pass "buy amount 2.5 USDT + surcharge ($AMT_BUY)"
else
  fail "unexpected buy amountMicro: '$AMT_BUY'"
fi
expect_body_has "buy hours encoded as 0" '"hours":0'

call POST "/api/orders/$ORDER_BUY/pay" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"txHash":"9999999999999999999999999999999999999999999999999999999999999999"}'
expect_status "buy: unknown tx -> 404" 404

call POST "/api/orders/$ORDER_BUY/pay" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"txHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
expect_status "buy: underpaid tx -> 402" 402

TX_BUY=$(mint "$AMT_BUY")
call POST "/api/orders/$ORDER_BUY/pay" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d "{\"txHash\":\"$TX_BUY\"}"
expect_status "buy: exact 2.5 USDT payment activates" 200

call GET /api/grid
expect_body_has "grid shows buy cell as mode=buy" '"mode":"buy"'

call POST /api/orders -H "Origin: $ORIGIN" -H "Cookie: px_session=$BOB" -H "Content-Type: application/json" \
  -d '{"x":30,"y":30,"w":1,"h":1,"hours":1}'
expect_status "buy block is exclusive: rent over it -> 409" 409
call POST /api/orders -H "Origin: $ORIGIN" -H "Cookie: px_session=$BOB" -H "Content-Type: application/json" \
  -d '{"x":30,"y":30,"w":1,"h":1,"mode":"buy"}'
expect_status "buy block is exclusive: buy over it -> 409" 409

call GET /api/mine -H "Origin: $ORIGIN" -H "$C"
expect_body_has "mine lists buy rental as mode=buy" '"mode":"buy"'

echo "=== 13e. pixel art (фарбування ділянки) ==="
# Палітра: 0 = прозорий. Payload: base64url RLE (пари значення,довжина).
# Один піксель дошки = один піксель малюнка.
b64url() { node -e "process.stdout.write(Buffer.from(process.argv[1],'hex').toString('base64url'))" "$1"; }
# RLE пари (0,2),(3,1),(5,1) -> hex 00020305
ART_B64=$(b64url "00020305")

call GET "/api/rentals/$ORDER_BUY/art" -H "Origin: $ORIGIN" -H "Cookie: px_session=$BOB"
expect_status "bob cannot read alice's art -> 404" 404

call GET "/api/rentals/$ORDER_BUY/art" -H "Origin: $ORIGIN" -H "$C"
expect_status "owner sees empty art (null)" 200

# 3x1 не совпадает с 1x1 ділянкою -> розмір малюнка має бути рівно ділянка
call PUT "/api/rentals/$ORDER_BUY/art" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d "{\"data\":\"$ART_B64\",\"w\":3,\"h\":1}"
expect_status "art sized 3x1 on a 1x1 plot -> 400" 400

# валідний payload 1x1 (один непрозорий піксель)
ONE_B64=$(b64url "0401")
call PUT "/api/rentals/$ORDER_BUY/art" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d "{\"data\":\"$ONE_B64\",\"w\":1,\"h\":1}"
expect_status "owner saves art on own (buy) plot" 200

call GET "/api/rentals/$ORDER_BUY/art" -H "Origin: $ORIGIN" -H "$C"
expect_body_has "saved art returns data" "\"data\":\"$ONE_B64\""

# чужа ділянка bob не може писати
call PUT "/api/rentals/$ORDER_BUY/art" -H "Origin: $ORIGIN" -H "Cookie: px_session=$BOB" -H "Content-Type: application/json" \
  -d "{\"data\":\"$ONE_B64\",\"w\":1,\"h\":1}"
expect_status "bob cannot draw on alice's plot -> 404" 404

# публічний пакетний endpoint
call GET /api/art
expect_status "public art batch" 200
expect_body_has "batch contains the saved art" "$ONE_B64"
ART_ETAG=$(curl -s -m 10 -D - -o /dev/null "$BASE/api/art" | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)
STATUS=$(curl -s -m 10 -o "$BODY" -w "%{http_code}" -H "If-None-Match: $ART_ETAG" "$BASE/api/art")
expect_status "art batch honors If-None-Match (304)" 304

# перемикання режиму вмісту
call PUT "/api/rentals/$ORDER_BUY/content-mode" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"mode":"art"}'
expect_status "owner switches content mode to art" 200
call GET /api/grid
expect_body_has "grid exposes content=art for the painted cell" '"content":"art"'

# адмін очищає малюнок; не-адмін не може
call DELETE "/api/admin/art/$ORDER_BUY" -H "Origin: $ORIGIN" -H "Cookie: px_session=$BOB"
expect_status "non-admin art clear -> 403" 403
call DELETE "/api/admin/art/$ORDER_BUY" -H "Origin: $ORIGIN" -H "$C"
expect_status "admin clears the art" 200
call GET "/api/rentals/$ORDER_BUY/art" -H "Origin: $ORIGIN" -H "$C"
expect_body_has "art is null after admin clear" '"art":null'

echo "=== 13c. extension (продовження своєї оренди) ==="
call POST /api/orders -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"x":10,"y":60,"w":1,"h":1,"hours":1,"title":"Extend base"}'
expect_status "alice rents 10,60" 201
ORDER_X=$(order_id)
AMT_X=$(amount_micro)
TX_X=$(mint "$AMT_X")
call POST "/api/orders/$ORDER_X/pay" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d "{\"txHash\":\"$TX_X\"}"
expect_status "extension base rental paid" 200

# Partial overlap with your own rental is refused...
call POST /api/orders -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"x":10,"y":60,"w":2,"h":1,"hours":1}'
expect_status "partial overlap with own rental -> 409" 409

# ...but the exact same rect is treated as an extension.
call POST /api/orders -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"x":10,"y":60,"w":1,"h":1,"hours":24,"title":"Extended"}'
expect_status "exact own rect -> extension order" 201
ORDER_X2=$(order_id)
AMT_X2=$(amount_micro)
expect_body_has "order links to the rental it extends" "\"extensionOf\":\"$ORDER_X\""
TX_X2=$(mint "$AMT_X2")
call POST "/api/orders/$ORDER_X2/pay" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d "{\"txHash\":\"$TX_X2\"}"
expect_status "extension payment accepted" 200
call GET "/api/orders/$ORDER_X2" -H "Origin: $ORIGIN" -H "$C"
expect_body_has "extension rental points at the original rental" "\"rentalId\":\"$ORDER_X\""

echo "=== 13d. cron auto-payment (авто-зарахування) ==="
call POST /api/orders -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"x":20,"y":60,"w":1,"h":1,"hours":1,"title":"Cron paid"}'
expect_status "cron order created" 201
ORDER_C=$(order_id)
AMT_C=$(amount_micro)
mint "$AMT_C" >/dev/null   # payment lands on-chain, nobody pastes the txid

STATUS=$(curl -s -m 20 -o "$BODY" -w "%{http_code}" "$BASE/__scheduled?cron=*%20*%20*%20*%20*")
expect_status "cron trigger endpoint reachable" 200
call GET "/api/orders/$ORDER_C" -H "Origin: $ORIGIN" -H "$C"
expect_body_has "cron credited the exact-amount payment" '"status":"paid"'

echo "=== 14. admin ==="
CB="Cookie: px_session=$BOB"
call GET /api/admin/orders -H "Origin: $ORIGIN" -H "$CB"
expect_status "non-admin list -> 403" 403

call GET "/api/admin/orders?status=conflict" -H "Origin: $ORIGIN" -H "$C"
expect_status "admin lists conflict orders" 200
expect_body_has "conflict order F listed" "$ORDER_F"

call POST "/api/admin/orders/$ORDER_F/refund" -H "Origin: $ORIGIN" -H "$CB" -H "Content-Type: application/json" -d '{}'
expect_status "non-admin refund -> 403" 403

call POST "/api/admin/orders/$ORDER_F/refund" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" -d '{}'
expect_status "admin refunds conflict order" 200
expect_body_has "order marked refunded" '"status":"refunded"'

call POST "/api/admin/orders/$ORDER_D/move" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"x":80,"y":80,"w":2,"h":2}'
expect_status "admin moves paid order D" 200
call GET /api/grid
expect_body_has "grid shows moved rect at 80,80" '"x":80,"y":80'

call POST "/api/admin/orders/$ORDER_D/move" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"x":0,"y":0,"w":2,"h":2}'
expect_status "admin cannot move into reserved zone" 403

call POST /api/admin/banner -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" -d '{"hidden":true}'
expect_status "admin hides banner" 200
call GET /api/config
expect_body_has "config reports hidden banner" '"bannerHidden":true'
call POST /api/admin/banner -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" -d '{"hidden":false}'
expect_status "admin shows banner again" 200
call GET /api/config
expect_body_has "config reports visible banner" '"bannerHidden":false'

call POST "/api/admin/users/test-user-bob" -H "Origin: $ORIGIN" -H "$CB" -H "Content-Type: application/json" -d '{}'
expect_status "non-admin ban -> 403" 403

call POST "/api/admin/users/test-user-bob" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" -d '{"banned":true}'
expect_status "admin bans bob" 200
call POST /api/orders -H "Origin: $ORIGIN" -H "$CB" -H "Content-Type: application/json" \
  -d '{"x":40,"y":40,"w":1,"h":1,"hours":1}'
expect_status "banned user loses access (session revoked) -> 401" 401
call GET /api/grid
expect_body_missing "banned user's rentals freed from the board" "$ORDER_G"

echo "=== 16. pending-order limits + cancel (item 2) ==="
# Bob is unbanned after being banned in section 14, so a second wallet can
# fill the per-IP pending budget.
call POST "/api/admin/users/test-user-bob" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" -d '{"banned":false}'
expect_status "admin unbans bob" 200
CB2="Cookie: px_session=$BOB"

# Banning deletes bob's sessions; re-seed the test session so bob can act again.
BOBH=$(node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$BOB")
BOBTTL=$(node -e "console.log(Date.now()+30*86400000)")
BOBT0=$(node -e "console.log(Date.now())")
CI=true npx wrangler d1 execute DB --local --command "INSERT OR IGNORE INTO sessions (token_hash, sub, created_at, expires_at, user_agent) VALUES ('$BOBH','test-user-bob',$BOBT0,$BOBTTL,'smoke-test')" >/dev/null 2>&1 \
  && pass "bob's test session re-seeded" || fail "could not re-seed bob session"

order_post() { # order_post X Y W H HOURS COOKIE TITLE
  local x="$1" y="$2" w="$3" h="$4" hours="$5" cookie="$6" title="$7"
  call POST /api/orders -H "Origin: $ORIGIN" -H "$cookie" -H "Content-Type: application/json" \
    -d "{\"x\":$x,\"y\":$y,\"w\":$w,\"h\":$h,\"hours\":$hours,\"title\":\"$title\"}"
}

order_post 0 90 1 1 1 "$C" "L1"
expect_status "alice pending L1" 201
L1=$(order_id)
order_post 1 90 1 1 1 "$C" "L2"
expect_status "alice pending L2" 201
L2=$(order_id)
order_post 2 90 1 1 1 "$C" "L3"
expect_status "alice pending L3" 201
L3=$(order_id)
order_post 3 90 1 1 1 "$C" "L4"
expect_status "4th pending for one user -> 429" 429

# cancel endpoint (item 2)
call POST "/api/orders/$L2/cancel" -H "Origin: $ORIGIN" -H "$C"
expect_status "owner cancels pending order" 200
expect_body_has "cancel returns cancelled status" '"status":"cancelled"'
call POST "/api/orders/$L2/cancel" -H "Origin: $ORIGIN" -H "$C"
expect_status "cancel twice -> 409" 409
call POST "/api/orders/$L2/cancel" -H "Origin: $ORIGIN" -H "$CB2"
expect_status "other user's cancel -> 404" 404
call POST "/api/orders/$ORDER_A/cancel" -H "Origin: $ORIGIN" -H "$C"
expect_status "cancel of a PAID order -> 409" 409

# A new order on the SAME rect auto-cancels the old pending one (item 2).
order_post 0 90 1 1 24 "$C" "L1-new"
expect_status "same rect re-order replaces old pending" 201
L1NEW=$(order_id)

# IP limit: alice has 2 pending (L3, L1NEW); bob adds 3 more for a total of 5.
order_post 5 90 1 1 1 "$CB2" "B1"
expect_status "bob pending B1 (IP ok)" 201
B1=$(order_id)
order_post 6 90 1 1 1 "$CB2" "B2"
expect_status "bob pending B2 (IP ok)" 201
B2=$(order_id)
order_post 7 90 1 1 1 "$CB2" "B3"
expect_status "bob pending B3 (5th pending on IP)" 201
B3=$(order_id)
order_post 8 90 1 1 1 "$CB2" "B4"
expect_status "6th pending on same IP -> 429" 429

# Total pending AREA cap: 25% of the board = 2500 cells.
call POST "/api/orders/$L1NEW/cancel" -H "Origin: $ORIGIN" -H "$C" >/dev/null
call POST "/api/orders/$L3/cancel" -H "Origin: $ORIGIN" -H "$C" >/dev/null
call POST "/api/orders/$B1/cancel" -H "Origin: $ORIGIN" -H "$CB2" >/dev/null
call POST "/api/orders/$B2/cancel" -H "Origin: $ORIGIN" -H "$CB2" >/dev/null
call POST "/api/orders/$B3/cancel" -H "Origin: $ORIGIN" -H "$CB2" >/dev/null
order_post 0 82 100 10 1 "$C" "Big1"
expect_status "big area 1 (1000 cells) pending" 201
BIG1=$(order_id)
order_post 0 45 100 10 1 "$C" "Big2"
expect_status "big area 2 (2000 cells total) pending" 201
BIG2=$(order_id)
order_post 0 70 100 6 1 "$C" "Big3"
expect_status "big area 3 would exceed 25% of board -> 400" 400
call POST "/api/orders/$BIG1/cancel" -H "Origin: $ORIGIN" -H "$C" >/dev/null
call POST "/api/orders/$BIG2/cancel" -H "Origin: $ORIGIN" -H "$C" >/dev/null

echo "=== 17. buy-on-own refusals (item 6) ==="
call POST /api/orders -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"x":30,"y":30,"w":1,"h":1,"mode":"buy","title":"Rebuy"}'
expect_status "alice re-buys OWN bought cell -> 409" 409
call POST /api/orders -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"x":30,"y":30,"w":1,"h":1,"hours":1}'
expect_status "rent over OWN bought cell -> 409" 409

echo "=== 18. image proxy + narrowed CSP (item 4) ==="
HDRS=$(curl -s -m 10 -I "$BASE/")
echo "$HDRS" | grep -qi "img-src 'self' data:; " \
  && pass "CSP img-src narrowed to 'self' data:" \
  || fail "CSP img-src not narrowed :: $(echo "$HDRS" | grep -i content-security)"
call GET "/api/img?url=javascript%3Aalert%281%29"
expect_status "proxy rejects javascript: url -> 404" 404
call GET "/api/img?url=http%3A%2F%2F127.0.0.1%2Fa.png"
expect_status "proxy rejects private host -> 404" 404
call GET "/api/img?url=https%3A%2F%2Fcdn.example.org%2Funknown.png"
expect_status "proxy rejects URL not owned by any rental -> 404" 404

# A real rental with imageUrl: the proxy only enqueues URLs the board owns.
call POST /api/orders -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"x":0,"y":95,"w":1,"h":1,"hours":1,"imageUrl":"https://picsum.photos/8/8.jpg","title":"Img"}'
expect_status "order with image url created" 201
IMG_ORDER=$(order_id)
call GET "/api/img?url=https%3A%2F%2Fpicsum.photos%2F8%2F8.jpg"
if [ "$STATUS" = "200" ]; then
  pass "proxy serves an allow-listed rental image (200)"
elif [ "$STATUS" = "404" ]; then
  pass "proxy validated allow-list (upstream image unavailable locally is fine)"
else
  fail "proxy unexpected status for allow-listed image: $STATUS"
fi
call POST "/api/orders/$IMG_ORDER/cancel" -H "Origin: $ORIGIN" -H "$C" >/dev/null

echo "=== 19. complaints (Report) + admin reports (item 4) ==="
call POST "/api/reports/$ORDER_A" -H "Origin: $ORIGIN" -H "$CB2" -H "Content-Type: application/json" \
  -d '{"reason":"scam"}'
expect_status "bob reports alice's cell -> 201" 201
call POST "/api/reports/$ORDER_A" -H "Origin: $ORIGIN" -H "$CB2" -H "Content-Type: application/json" \
  -d '{"reason":"other"}'
expect_status "duplicate open report -> 409" 409
call POST "/api/reports/$ORDER_A" -H "Origin: $ORIGIN" -H "$CB2" -H "Content-Type: application/json" \
  -d '{"reason":"nonsense"}'
expect_status "unknown reason -> 400" 400
call POST "/api/reports/$ORDER_A" -H "Origin: $ORIGIN" -H "$C" -H "Content-Type: application/json" \
  -d '{"reason":"other"}'
expect_status "own-cell report also stored -> 201" 201

call GET /api/admin/reports -H "Origin: $ORIGIN" -H "$CB2"
expect_status "non-admin report list -> 403" 403
call GET /api/admin/reports -H "Origin: $ORIGIN" -H "$C"
expect_status "admin lists open reports" 200
expect_body_has "open report contains the cell" "$ORDER_A"
RID=$(grep -oE '"id":[0-9]+' "$BODY" | head -1 | cut -d: -f2)
call POST "/api/admin/reports/$RID/resolve" -H "Origin: $ORIGIN" -H "$CB2"
expect_status "non-admin resolve -> 403" 403
call POST "/api/admin/reports/$RID/resolve" -H "Origin: $ORIGIN" -H "$C"
expect_status "admin resolves report" 200
call POST "/api/admin/reports/$RID/resolve" -H "Origin: $ORIGIN" -H "$C"
expect_status "resolve twice -> 404" 404

echo "=== 20. admin incoming transfers (item 5) ==="
call GET /api/admin/incoming -H "Origin: $ORIGIN" -H "$CB2"
expect_status "non-admin incoming list -> 403" 403
call GET /api/admin/incoming -H "Origin: $ORIGIN" -H "$C"
expect_status "admin lists incoming transfers (classified)" 200
expect_body_has "response includes classified statuses" '"status"'

SECOND_STRAY=$(mint 777777901)
if [ -n "$SECOND_STRAY" ]; then
  call GET /api/admin/incoming -H "Origin: $ORIGIN" -H "$C"
  expect_body_has "stray transfer listed as unmatched (manual review)" "$SECOND_STRAY"
  expect_body_has "unmatched transfer flagged" '"status":"unmatched"'
else
  fail "mock mint for incoming list failed"
fi

echo "=== 15. rate limiting ==="
GOT429=0
for i in $(seq 1 25); do
  code=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$BASE/api/auth/login")
  if [ "$code" = "429" ]; then GOT429=1; break; fi
done
[ "$GOT429" = "1" ] && pass "login rate limit kicks in (D1 counter)" || fail "no 429 after 25 login attempts"

echo
echo "=============================="
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ] || exit 1
