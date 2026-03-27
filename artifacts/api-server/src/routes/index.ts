import { Router, type IRouter } from "express";
import healthRouter from "./health";
import uploadRouter from "./upload";
import jobsRouter from "./jobs";

const router: IRouter = Router();

router.use(healthRouter);
router.use(uploadRouter);
router.use(jobsRouter);

export default router;
