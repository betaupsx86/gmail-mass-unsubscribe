# Gmail Mass Unsubscribe

You can select all 10,000 emails in Gmail and delete them in one click.
So why can't you unsubscribe from all of them at once?

Now you can.

Gmail Mass Unsubscribe scans your inbox, promotions, or any Gmail search
and automatically unsubscribes you from every mailing list it finds —
in bulk, in the background, while you do other things.

## How it works

- Pick a category (Promotions, Updates, Social) or any Gmail search query
- Filter by age, read/unread, starred, importance
- Hit Start — the extension reads each email's `List-Unsubscribe` header
  and fires the unsubscribe request directly to the sender, the same
  one-click request your browser would send if you clicked "Unsubscribe"
  yourself
- For senders that only support email-based unsubscribes, it sends the
  unsubscribe email through your Gmail account so it arrives from
  Google's servers — the same way Gmail's own button works
- Optionally trash successfully unsubscribed threads when done

## Floating button

A small button lives on your Gmail page so you can select specific
emails by hand and unsubscribe just those — no need to open the popup.

## Privacy — zero servers

This extension has no backend. No server. No database. No analytics.
Nothing leaves your browser except:

1. The Gmail API calls you explicitly trigger, which go directly from
   your browser to Google, and
2. The unsubscribe requests themselves, which go directly from your
   browser to each sender's unsubscribe link — exactly the request a
   normal click on "Unsubscribe" would make.

Your emails are never read by us. We don't store anything. We don't
know who you are. The OAuth token lives only in Chrome, on your device.

Full privacy policy: [docs/privacy.html](docs/privacy.html)

## Permissions explained

| Permission | Why it's needed |
| --- | --- |
| `gmail.modify` | Read `List-Unsubscribe` headers, send unsubscribe emails, and optionally move threads to Trash. Minimum Gmail scope that covers all three actions. |
| `identity` | Google sign-in via Chrome's built-in OAuth flow. |
| `storage` | Saves your limit/trash preferences locally. |
| `tabs` | Reads the current Gmail URL to detect which view you're in. |
| `host_permissions` (all sites) | Required to send the actual unsubscribe request to each sender's domain (e.g. `linkedin.com`, `medium.com`). Without it, Chrome blocks the extension from contacting any site other than Gmail, so unsubscribe links would fail. The extension only ever contacts the exact unsubscribe URL found in each email — it doesn't browse, track, or read any other site. |

## Development

Run `./scripts/setup-dev.sh` to generate a local `dev/` build with a
separate OAuth client ID for unpacked testing, then load `dev/` in
`chrome://extensions`. See [NOTES.md](NOTES.md) for implementation notes
and known edge cases.
