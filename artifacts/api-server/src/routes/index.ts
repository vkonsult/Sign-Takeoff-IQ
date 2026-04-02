import { Router, type IRouter } from "express";
import healthRouter from "./health";
import uploadRouter from "./upload";
import jobsRouter from "./jobs";
import knowledgeRouter from "./knowledge";
import trainingRouter from "./training";
import adminRouter from "./admin";
import { requireAuth } from "../middlewares/authMiddleware";

const router: IRouter = Router();

router.use(healthRouter);
router.use(requireAuth);
router.use(uploadRouter);
router.use(jobsRouter);
router.use(knowledgeRouter);
router.use(trainingRouter);
router.use(adminRouter);

export default router;
