#!/bin/bash
#
# Smoke test against a deployed Forge.
#
# Covers everything reachable without GitHub credentials: the router and its
# mount path, the auth boundary, both OAuth discovery spellings, dynamic client
# registration (which exercises D1 for real), PKCE hardening, the public privacy
# notice, and the rule that an unknown approval or capture must answer identically
# to a wrong token so the URL cannot be used to learn what exists.
#
#   worker/scripts/smoke.sh [base-url]
#
B="${1:-https://timcoy.uk/forge}"
pass=0; fail=0
chk() { # name expected actual
  if [[ "$3" == *"$2"* ]]; then printf "  \033[32m✓\033[0m %s\n" "$1"; pass=$((pass+1));
  else printf "  \033[31m✗\033[0m %s\n      expected: %s\n      got:      %s\n" "$1" "$2" "${3:0:180}"; fail=$((fail+1)); fi
}
code() { curl -s -o /dev/null -w "%{http_code}" --max-time 25 "$@"; }
body() { curl -s --max-time 25 "$@"; }

echo "── liveness"
chk "health answers"                 '{"status":"ok"}' "$(body $B/health)"
chk "unknown route 404s"             "404"            "$(code $B/nope)"
chk "mount root serves the page"     "Forge"          "$(body $B)"
# GitHub always appends a query when returning from an install, and an exact
# Cloudflare route does not match one. This is that regression.
chk "mount root survives a query"    "Forge"          "$(body "$B?x=1")"
chk "post-install is acknowledged"   "installed"      "$(body "$B?installation_id=1&setup_action=install")"
chk "page names the server url"      "/forge/mcp"     "$(body $B)"
chk "page links the github app"      "installations/new" "$(body $B)"
chk "privacy page answers"           "Privacy"        "$(body $B/privacy)"
chk "privacy page names deletion"    "deleted"        "$(body $B/privacy)"
chk "site root untouched"            "200"            "$(code https://timcoy.uk/)"

echo "── auth boundary"
chk "mcp without token 401s"         "401"            "$(code -X POST $B/mcp -H 'content-type: application/json' -d '{}')"
chk "mcp with junk token 401s"       "401"            "$(code -X POST $B/mcp -H 'authorization: Bearer nonsense' -d '{}')"
chk "challenge names discovery"      "resource_metadata" "$(curl -s -i --max-time 25 -X POST $B/mcp -d "{}" | tr -d '\r' | grep -i www-authenticate)"
chk "401 body is a forge error"      "FORGE_AUTH_REQUIRED" "$(body -X POST $B/mcp -d '{}')"

echo "── oauth discovery (both spellings)"
chk "protected-resource (append)"    '"resource"'     "$(body $B/.well-known/oauth-protected-resource)"
chk "protected-resource (rfc8414)"   '"resource"'     "$(body https://timcoy.uk/.well-known/oauth-protected-resource/forge)"
chk "auth-server (append)"           '"issuer"'       "$(body $B/.well-known/oauth-authorization-server)"
chk "auth-server (rfc8414)"          '"issuer"'       "$(body https://timcoy.uk/.well-known/oauth-authorization-server/forge)"
chk "issuer names the mount"         'timcoy.uk/forge' "$(body $B/.well-known/oauth-authorization-server)"
chk "PKCE S256 advertised"           'S256'           "$(body $B/.well-known/oauth-authorization-server)"
chk "offline access advertised"      'offline_access' "$(body $B/.well-known/oauth-authorization-server)"
chk "refresh grant advertised"       'refresh_token'  "$(body $B/.well-known/oauth-authorization-server)"

echo "── dynamic client registration (exercises D1)"
REG=$(body -X POST $B/oauth/register -H 'content-type: application/json' \
  -d '{"client_name":"smoke","redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"]}')
chk "registers an allowed redirect"  'client_id'      "$REG"
chk "no client secret issued"        ''               "$(echo "$REG" | grep -o client_secret)"
BAD=$(body -X POST $B/oauth/register -H 'content-type: application/json' \
  -d '{"client_name":"evil","redirect_uris":["https://attacker.example/cb"]}')
chk "refuses a foreign redirect"     'invalid'        "$(echo "$BAD" | tr 'A-Z' 'a-z')"

echo "── authorize hardening"
CID=$(echo "$REG" | sed -n 's/.*"client_id":"\([^"]*\)".*/\1/p')
chk "rejects plain PKCE"             "400"            "$(code "$B/oauth/authorize?client_id=$CID&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector_platform_oauth_redirect&response_type=code&code_challenge=abc&code_challenge_method=plain")"
chk "rejects unknown client"         "400"            "$(code "$B/oauth/authorize?client_id=not-a-client&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fcb&response_type=code&code_challenge=abc&code_challenge_method=S256")"
chk "token rejects bad grant"        "invalid_grant"  "$(body -X POST $B/oauth/token -H 'content-type: application/x-www-form-urlencoded' -d 'grant_type=authorization_code&code=nope&code_verifier=xyz&client_id='"$CID")"
chk "token rejects bad refresh"      "invalid_grant"  "$(body -X POST $B/oauth/token -H 'content-type: application/x-www-form-urlencoded' -d 'grant_type=refresh_token&refresh_token=nope&client_id='"$CID")"

echo "── approvals and captures are not oracles"
chk "unknown approval is not a 500"  "404"            "$(code $B/approvals/11111111-1111-1111-1111-111111111111?t=wrong)"
chk "approval POST needs a decision" "400"            "$(code -X POST $B/approvals/11111111-1111-1111-1111-111111111111?t=wrong)"
chk "approval rejects PUT"           "405"            "$(code -X PUT $B/approvals/11111111-1111-1111-1111-111111111111?t=wrong)"
chk "unknown capture 404s"           "404"            "$(code $B/see/11111111-1111-1111-1111-111111111111?t=wrong)"

echo "── one design system"
for path in "" "/privacy" "/approvals/11111111-1111-1111-1111-111111111111?t=x" "/see/11111111-1111-1111-1111-111111111111?t=x"; do
  html="$(body "$B$path")"
  chk "shared shell on ${path:-/}"    'class="mark"'      "$html"
  chk "skip link on ${path:-/}"       'Skip to content'   "$html"
done

echo "── nothing leaks"
ALL="$(body $B/health)$(body $B/.well-known/oauth-authorization-server)$REG$(body -X POST $B/mcp -d '{}')"
for s in "BEGIN PRIVATE KEY" "GITHUB_APP" "CLOUDFLARE_API" "FORGE_SIGNING_KEY" "Iv23li"; do
  if [[ "$ALL" == *"$s"* ]]; then printf "  \033[31m✗\033[0m leaked: %s\n" "$s"; fail=$((fail+1));
  else printf "  \033[32m✓\033[0m no %s in any response\n" "$s"; pass=$((pass+1)); fi
done

echo
printf "  %d passed, %d failed\n" "$pass" "$fail"
exit $fail
