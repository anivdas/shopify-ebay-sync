# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private
[**Report a vulnerability**](../../security/advisories/new) button (Security tab)
instead. You'll get a reply as soon as possible.

## Keeping your installation safe

- Never share your `data/` folder. It contains your encrypted API keys and `secret.key`.
- Don't forward port 8080 on your router. For remote access, use a VPN (e.g. Tailscale) or a Cloudflare Tunnel (see the README).
- Use a strong dashboard password and keep the app updated.
- If you think a key leaked, rotate it: regenerate the Shopify client secret in the Dev Dashboard and the eBay Cert ID in the eBay developer portal, then paste the new values in Settings → Connections.
