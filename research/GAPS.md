# GAPS — sources that could not be captured (and why)

Harvested 2026-06-17. Everything else listed in `INDEX.md` fetched/cloned successfully.

## Hard failures

| Source | Reason | Notes / workaround |
|---|---|---|
| `https://privacypools.com/whitepaper.pdf` | **Site down** — `curl` got `Connection refused` / Cloudflare `522`; `WebFetch` got `ECONNREFUSED`. Tried both `privacypools.com` and `www.privacypools.com`. | This is the academic paper *"Blockchain Privacy and Regulatory Compliance: Towards a Practical Equilibrium"* (Buterin, Illum, Nadler, Schär, Soleimani, Sept 2023). Canonical copies: **SSRN abstract 4563364** (`https://ssrn.com/abstract=4563364`) and **ScienceDirect `S2096720923000519`** (open access; bot-walled with 403 when scripted). Retry from a browser or a residential IP. The ASP allow/deny-list + association-set *mechanics* are also captured verbatim in code/docs under `github/stellar-private-payments/contracts/asp-membership` and `asp-non-membership`, and in `github/soroban-examples/privacy-pools/`. |
| `https://dorahacks.io/hackathon/stellar-hacks-zk/` | **HTTP 405 Method Not Allowed** for both `curl` and `WebFetch` (DoraHacks blocks non-browser clients). | The prompt itself predicted this. The 2.6k block page is saved at `website/dorahacks-stellar-hacks-zk.html`. Capture manually from a browser if the live hackathon page is needed. Related accessible page found via search: `https://dorahacks.io/hackathon/stellar-hacks-zk-gaming/resources`. |

## Partial / quality notes (not failures, but read these)

- **Docusaurus `.md`-append trick does NOT work** on `developers.stellar.org`. Appending `.md` returns the site's 404 *search* page (HTTP 404, ~59k bytes) — not raw markdown. The two early files captured this way were deleted. All Stellar doc pages were instead captured as **rendered HTML** (`docs/stellar/*.html`, content is server-side-rendered so it's present) and, for the priority ZK/privacy pages, as **clean `.mdx` git source** from the cloned `stellar-docs` repo (`*.source.mdx`).
- **Web/website captures are raw HTML** (verbatim, including Docusaurus/nav/script boilerplate). Content is present in the HTML (SSR). They are not converted to clean markdown — that was a deliberate choice to honor "DO NOT SUMMARIZE" (no model-rewriting). For clean reading of Stellar docs, prefer the `github/stellar-docs/` source.
- **`confidential-token-video-page.html`** is the YouTube *watch page* HTML (1.0 MB). YouTube renders the transcript client-side, so a plain transcript is **not** in the captured HTML. If a transcript is needed, pull it via a transcript API/tool. The spec text itself is on `confidentialtoken.org` (captured).
- **`stellar-docs` clone** failed twice first (network `early EOF` / `invalid index-pack`, then a self-collision during a retry race) before succeeding on the third attempt — final clone is complete (2828 files). No data missing.
- **Cloned repos are depth-1** (shallow). Full history is not present; that's intentional for size. No content gaps in working trees.
- **No auth walls hit** that required your credentials. Nothing here needs a credential you hold — the two hard failures are server-side availability/bot-blocking, not auth.

## Sanity checks I could not fully resolve

- **Protocol numbering**: the official `zk.mdx` states **"X-Ray (Protocol 25)"** introduced BN254 + Poseidon host functions; some third-party articles say "Protocol 24". Treated the SDF docs/CAPs as authoritative (Protocol 25 = X-Ray, Protocol 26 = Yardstick). Confirm against `github/stellar-protocol/core/` CAP headers before relying on exact protocol numbers.
- **Exact `stellar` CLI version**: docs only say `cargo install stellar-cli --locked` (latest). Pin a specific version yourself for reproducible builds.
