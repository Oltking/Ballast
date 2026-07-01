// GET /api/ping → "pong". Zero imports — a canary to confirm the serverless
// runtime itself is healthy independent of the rest of the backend's modules.
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.status(200).setHeader("content-type", "application/json");
  res.send(JSON.stringify({ pong: true, at: new Date().toISOString() }));
}
