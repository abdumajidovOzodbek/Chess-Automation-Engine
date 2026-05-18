import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import sessionsRouter from "./sessions.js";
import analyzeRouter from "./analyze.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(sessionsRouter);
router.use(analyzeRouter);

export default router;
