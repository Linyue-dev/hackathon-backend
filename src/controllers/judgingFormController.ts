import express, { Request, Response } from "express";
import * as judgingFormModel from "../models/JudgingForm.js";
import { handleError } from "../utils/errorHandler.js";
import type { IdParams } from "../utils/types.js";

const router = express.Router();
export const routeRoot = "/api/v1";

// ============ Routes ============
// The id in the path is the award id
router.get("/awards/:id/form", getForm);
router.put("/awards/:id/form", replaceForm);

// ============ Handlers ============

async function getForm(req: Request<IdParams>, res: Response) {
  try {
    res.json(await judgingFormModel.getFormByAwardId(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}
async function replaceForm(req: Request<IdParams>, res: Response) {
  try {
    const { criteria, instructions } = req.body;
    const form = await judgingFormModel.replaceFormForAward(req.params.id, {
      criteria,
      instructions,
    });
    res.json(form);
  } catch (err) {
    handleError(err, res);
  }
}
export default router;
