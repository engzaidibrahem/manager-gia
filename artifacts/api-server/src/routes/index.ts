import { Router, type IRouter } from "express";
import healthRouter from "./health";
import operationsRouter from "./operations";
import restaurantRouter from "./restaurant";

const router: IRouter = Router();

router.use(healthRouter);
router.use(restaurantRouter);
router.use(operationsRouter);

export default router;
