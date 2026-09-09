import { Router, type IRouter } from "express";
import authRouter from "./auth";
import healthRouter from "./health";
import operationsRouter from "./operations";
import restaurantRouter from "./restaurant";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(restaurantRouter);
router.use(operationsRouter);

export default router;
