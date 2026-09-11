import { Router, type IRouter } from "express";
import authRouter from "./auth";
import healthRouter from "./health";
import operationsRouter from "./operations";
import restaurantRouter from "./restaurant";
import v3Router from "./v3";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(restaurantRouter);
router.use(operationsRouter);
router.use("/v3", v3Router);

export default router;
