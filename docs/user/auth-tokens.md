# Auth Tokens

Users sign in with GitHub at `/login`, then mint API tokens for `cyanprint push` from `/account/tokens`.

Token secrets are shown once. The registry stores only token hashes and supports token listing and revocation.

Production OAuth needs a GitHub OAuth app:

- Homepage URL: `https://cyanprint.dev`
- Authorization callback URL: `https://registry.cyanprint.dev/auth/github/callback`

Set the Cloudflare Worker secret once:

```bash
export CYANPRINT_GITHUB_CLIENT_SECRET="<github-oauth-client-secret>"
unset CLOUDFLARE_API_TOKEN
pls deploy:release
```

Later deploys do not need `CYANPRINT_GITHUB_CLIENT_SECRET`; the deploy script assumes the existing Cloudflare Worker secret is still present.

For GitHub Actions deploys, set `CYANPRINT_GITHUB_CLIENT_ID` and `CYANPRINT_GITHUB_ADMIN_LOGINS` as repository or organization variables. Set `CYANPRINT_GITHUB_CLIENT_SECRET` as a secret.
