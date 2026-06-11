# Notes: "Failed to fetch" on unsubscribe links (LinkedIn, etc.)

## Symptom
Mass-unsubscribe report shows entries like:

```
LinkedIn <messages-noreply@linkedin.com>
  Reason: [header] Failed to fetch
```

`[header]` means the URL came from the email's `List-Unsubscribe` header (found fine).
`Failed to fetch` is a `TypeError` thrown by `fetch()` itself — no HTTP status was
ever returned, meaning the request was blocked before it left/completed.

## Root cause
`background.js` (`doUnsubscribe()`) runs `fetch(url, ...)` directly against
whatever third-party URL is in the `List-Unsubscribe` header.

`host_permissions` in `manifest.json` previously only covered:
- `https://mail.google.com/*`
- `https://www.googleapis.com/*`

In MV3, an extension's background `fetch()` is exempt from CORS **only** for
origins listed in `host_permissions`. For any other origin (e.g. `linkedin.com`),
`fetch()` behaves like a normal cross-origin page request — if the target server
doesn't return permissive CORS headers (most one-click unsubscribe pages on
real sites like LinkedIn don't), the browser blocks the response and `fetch()`
rejects with `TypeError: Failed to fetch`. No status code is ever visible to the
extension.

This is why **most unsubscribes work but LinkedIn's don't**: most senders use
bulk-email platforms (Mailchimp, SendGrid, etc.) whose unsubscribe endpoints are
built to be hit programmatically and send permissive CORS headers. LinkedIn's
unsubscribe link points back at `linkedin.com` itself, a normal locked-down site.

Note: Gmail's own "Unsubscribe" button works because *Google's servers* make
that request server-side — server-to-server calls aren't subject to CORS at all.
The extension can't replicate that mechanism (no public API for it), but it can
get an equivalent result by being granted the same CORS bypass Google enjoys.

## Fix applied
Added broad host permissions to `manifest.json`:

```json
"host_permissions": [
  "https://mail.google.com/*",
  "https://www.googleapis.com/*",
  "https://*/*",
  "http://*/*"
]
```

With these, the background service worker's `fetch()` to any domain bypasses
CORS, same as a privileged server-to-server call. Chrome will show a broader
permission warning ("Read and change all your data on all websites") on
install/update as a result.

## Manual test (2026-06-11)
Couldn't read the raw `List-Unsubscribe` header via the available Gmail
connector (only message body content), so tested the unsubscribe link found in
the email's HTML footer instead (`linkedin.com/comm/mypreferences/u/emailunsub?...`):

```
GET  -> HTTP 200
POST List-Unsubscribe=One-Click -> HTTP 403
```

**Caveats / why this may still partially fail for LinkedIn even after the fix:**

1. The actual `List-Unsubscribe` header URL wasn't directly testable and may
   differ from the footer link tested above.
2. The 403 on POST suggests this LinkedIn link expects a GET (presumably a
   "click to confirm" page tied to a logged-in session), not an RFC 8058
   one-click POST.
3. `doUnsubscribe()` doesn't send `credentials: 'include'`, so even a GET
   won't carry the user's `linkedin.com` session cookie — it may land on a
   "log in to manage your subscriptions" page instead of actually unsubscribing.

**Expected outcome after this fix:** `Failed to fetch` (CORS block, no info)
should become a real status code (e.g. `200`, `403`, `(POST)403`), which is
strictly more informative even if some LinkedIn links still report failure.
If LinkedIn entries still fail post-fix, the next step would be adding
`credentials: 'include'` to the fetch in `doUnsubscribe()` for non-Google
hosts, and/or trying GET even when `List-Unsubscribe-Post` is present.

## Dev vs. published OAuth client IDs
GCP's "Chrome Extension" OAuth client type is tied to one specific extension
ID. The Web Store-published extension and a locally-loaded "unpacked" copy
get *different* IDs, so they need *different* OAuth clients:

- Published: `396260624027-3bcefdsge0kssjcslc4qmicldoocahij...` (in
  `manifest.json`, committed — this is what ships to the Web Store)
- Local unpacked dev: `396260624027-g6p0gf57jtl7t0c0305j7odrife1g2c8...`
  (registered in GCP against the unpacked extension's local ID)

To test locally: run `./scripts/setup-dev.sh`, then load the generated
`dev/` folder (gitignored) as an unpacked extension in
`chrome://extensions`. It's a copy of the repo with only `oauth2.client_id`
swapped to the dev client. (Originally this used symlinks, but Chrome's
unpacked-extension loader doesn't reliably load symlinked content scripts —
content.js silently failed to inject, breaking the floating button, popup
tab-detection, and sign-out.)

**Re-run `./scripts/setup-dev.sh` after every source edit**, then click
reload on the extension card in `chrome://extensions`.

`manifest.json` at the repo root always stays the published/prod version —
never edit its `client_id` for local testing.

## Edge case: "[header] 422" (e.g. Calendly)
Some senders (Calendly notification emails) advertise `List-Unsubscribe-Post:
List-Unsubscribe=One-Click`, but the linked endpoint
(`/notification_subscriptions/.../opt_out`) is actually a Rails browser-click
(GET) link. POSTing the RFC 8058 one-click body to it trips Calendly's CSRF
protection and returns `422 Unprocessable Entity`. A plain GET to the same
URL returns `302` (redirect to a confirmation page) and works fine.

Manually verified with curl on 2026-06-11 (UUIDs reconstructed from the
mangled email body — connector drops bytes in long query strings):
```
GET  -> 302
POST List-Unsubscribe=One-Click -> 422
```

Fix: `doUnsubscribe()` in `background.js` now falls back to GET if the
one-click POST returns a non-2xx status, reporting status as
`<postStatus>→<getStatus>(GET)`.

## Edge case: "[header] timeout" (e.g. LinkedIn InMail/digest emails)
A full-batch run (2026-06-11) showed ~12 `timeout` failures, almost all
from `inmail-hit-reply@linkedin.com` / `messaging-digest-noreply@linkedin.com`.

Manually curling one of these unsubscribe links in isolation returned a
200 in ~0.4s — well under the 10s timeout. So the link itself isn't slow;
the timeouts are most likely **self-inflicted concurrency**: `runJob` runs
5 workers in parallel, and a batch with many LinkedIn emails sends several
near-simultaneous requests to `linkedin.com`, which appears to throttle/stall
some of them past 10s.

Fix: `doUnsubscribe()` now retries once after a 1.5s backoff if the first
attempt times out (`attemptUnsubscribe()` holds the original single-try
logic; `doUnsubscribe()` wraps it with the retry). This doesn't reduce
concurrency but gives a throttled request a second chance after the initial
burst has eased.

If LinkedIn timeouts persist after this fix, the next step would be to
reduce concurrency specifically for `linkedin.com` (e.g. a per-host
semaphore in `runJob`), since LinkedIn rate-limiting is the most likely
remaining cause.

## Edge case: "[header] 500" (Meta/Facebook recruiting emails)
Facebook's recruiting opt-out link (`facebook.com/o.php?k=...`) rejects a
plain GET with `500`, but accepts the RFC 8058 one-click POST (`200`).
Previously `doUnsubscribe()` only fell back from GET to POST on `403`/`405`,
so a `500` was reported as-is and the working POST was never tried.

Manually verified with curl on 2026-06-11 (reconstructed URL from a Meta
recruiting "future consideration" email):
```
GET                              -> 500
POST List-Unsubscribe=One-Click  -> 200
```

Fix: the GET branch of `doUnsubscribe()` now falls back to POST on **any**
non-2xx GET response (not just 403/405), reporting
`<getStatus>→<postStatus>(POST)`.

## Known limitation: IP/origin-allowlisted unsubscribe endpoints (unfixable)
Some senders' one-click `List-Unsubscribe` endpoints return `403`/`404` to
**both** GET and POST, no matter what — `doUnsubscribe()` already sends
browser-like headers and tries both methods with fallback, and both come
back rejected.

In at least one case, Gmail's own built-in "Unsubscribe" button succeeded
for an email where the extension got `403` on both GET and POST. Gmail's
unsubscribe is a cookie-less, server-to-server request from Google's
infrastructure, so "needs a logged-in session" doesn't explain it.

Most likely cause: these endpoints **allowlist requests by source IP/origin**
— only accepting one-click unsubscribes from known mailbox-provider
infrastructure (Google/Microsoft/Yahoo), and rejecting everything else. This
stops someone who finds/leaks an unsubscribe link from using it to
unsubscribe *other* people.

**This cannot be worked around from a browser extension** — there's no way
to make `fetch()` originate from a mail provider's IP ranges. For senders
like this, Gmail's built-in "Unsubscribe" button (or the sender's in-account
settings page) is the only thing that works.

## Other failure patterns (not fixed — dead/expired links, expected)
- Repeated `[header] Failed to fetch` for one sender — curl gets a TLS
  handshake failure (not even an HTTP response) on this URL, likely a WAF
  blocking curl's TLS fingerprint — inconclusive whether Chrome's `fetch()`
  from the extension would also be blocked. Can't verify further without
  testing in the actual extension.
- `[html] 400→400(POST)` for one sender — the unsubscribe link is an old
  (2019) email-platform click-tracking URL that has expired; the platform
  itself returns a `"Wrong Link"` error page. Dead link, same in a real
  browser.
- "NO UNSUBSCRIBE LINK FOUND" (2625 entries) — mostly transactional mail
  (Amazon, banks, GitHub, calendar invites) that legitimately has no
  unsubscribe link. Expected, not a bug.
