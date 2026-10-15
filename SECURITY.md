# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/Terse-AI/webapp-anything/security/advisories/new). Do not open a
public issue. We aim to respond within five working days.

## Threat model

- **Uploaded programs** run in the visitor's browser, inside the WebAssembly sandbox of the chosen runtime. They do
  not run on the server, except with the `stream` backend, which you run yourself in Docker.
- **Uploaded web content** (the `web` and `electron` backends, and any bundle uploaded with `PUT /api/apps/:slug`) is
  arbitrary HTML and JavaScript. If you accept uploads from people you do not trust, set
  `--app-origin https://{slug}.apps.example.com`. Each app then gets its own origin and cannot read the server's
  API, other apps' storage or service workers. Without it, every app shares the server's origin.
- **Archives** are read through their central directory. Entries that escape the root (`..`, absolute paths,
  drive letters) are rejected, and entry counts, total uncompressed size and CRCs are checked.
- **Authentication** is a single publish token, compared in constant time, and per-app delete keys that are stored
  only as sha256 hashes. With `--open-uploads`, anonymous uploads are rate-limited per IP. Set
  `WAA_TRUST_PROXY=1` only behind a reverse proxy that overwrites `X-Forwarded-For`.
- **Runtimes** are pinned by version and verified by hash before they are cached or copied into bundles.
  CheerpJ and CheerpX are loaded from Leaning Technologies' CDN at run time.

## Hardening checklist for public servers

- Put the server behind a TLS reverse proxy and set `--public-url`.
- Use `--app-origin` with a wildcard DNS record and certificate.
- Keep `--max-upload` as low as your use case allows.
- Back up the data folder; it holds the token and every published app.
