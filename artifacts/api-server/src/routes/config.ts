import { Router, type IRouter } from "express";

const router: IRouter = Router();

/**
 * Returns server-side defaults for the session creation form.
 * Credentials are sourced from CF_USERNAME / CF_PASSWORD env vars (Replit Secrets)
 * so they never need to be typed into the UI on every session start.
 */
router.get("/config", (_req, res) => {
  res.json({
    chessfriends: {
      username: process.env["CF_USERNAME"] ?? null,
      /** Never expose the password value — just signal whether one is saved */
      hasPassword: !!process.env["CF_PASSWORD"],
      /** The actual password is sent only to the session-creation endpoint server-side */
      password: process.env["CF_PASSWORD"] ?? null,
    },
    stockfish: {
      /** Maximum strength defaults */
      depth: 30,
      movetime: 10_000,
      moveDelayMs: 350,
      moveJitterMs: 600,
    },
  });
});

export default router;
