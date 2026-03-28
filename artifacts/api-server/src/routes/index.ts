import { Router, type IRouter } from "express";
import healthRouter from "./health";
import uploadRouter from "./upload";
import jobsRouter from "./jobs";
import knowledgeRouter from "./knowledge";

const router: IRouter = Router();

router.use(healthRouter);
router.use(uploadRouter);
router.use(jobsRouter);
router.use(knowledgeRouter);

export default router;
