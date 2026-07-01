// POST /api/prove-trigger  { workflow?: "solvency" | "passport" }
// Kicks the GitHub Actions prover so the on-chain attestation refreshes after a
// deposit/withdraw (instead of waiting for the 12h cron). Permissionless but
// **debounced** server-side (a re-prove is harmless — it only makes the proof
// fresher — but CI runs cost time, so we rate-limit). Needs `GITHUB_DISPATCH_TOKEN`
// (a token with actions:write) and `GITHUB_REPO` (owner/repo).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { body, cors, handleError, json } from "./_lib/http.js";
import { getStore } from "./_lib/store.js";

const WORKFLOWS: Record<string, string> = {
  solvency: "prove-and-post.yml",
  passport: "passport.yml",
};
const DEBOUNCE_SECONDS = Number(process.env.PROVE_DEBOUNCE_SECONDS || 600);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const which = String(body(req).workflow ?? "solvency");
    const file = WORKFLOWS[which];
    if (!file) return json(res, 400, { error: "unknown workflow" });

    const token = process.env.GITHUB_DISPATCH_TOKEN;
    const repo = process.env.GITHUB_REPO || "Oltking/Ballast";
    if (!token) return json(res, 503, { error: "GITHUB_DISPATCH_TOKEN not configured" });

    // Debounce: at most one trigger per workflow per window.
    const fresh = await getStore().acquireOnce(`prove:${which}`, DEBOUNCE_SECONDS);
    if (!fresh) {
      return json(res, 200, { triggered: false, reason: "debounced", windowSeconds: DEBOUNCE_SECONDS });
    }

    const resp = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${file}/dispatches`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
          "user-agent": "ballast-backend",
        },
        body: JSON.stringify({ ref: "main" }),
      },
    );
    if (!resp.ok) {
      const text = await resp.text();
      return json(res, 502, { triggered: false, error: `github ${resp.status}: ${text}` });
    }
    return json(res, 200, { triggered: true, workflow: which });
  } catch (e) {
    handleError(res, e);
  }
}
