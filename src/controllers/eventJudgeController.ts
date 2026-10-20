import express, { Request, Response } from "express";
import { IdParams } from "../utils/types.js";
import * as eventJudgeModel from "./../models/EventJudge.js";
import { handleError } from "../utils/errorHandler.js";
import { InvalidInputError } from "../errors/InvalidInputError.js";
import { parsePagination } from "../utils/pagination.js";

const router = express.Router();
export const routeRoot = "/api/v1";
type EventJudgeParams = IdParams & { judgeId: string };

// ============ Routes ============
// The id in the path is the event id
router.post("/events/:id/assignJudge", assignJudges);
router.get("/events/:id/judges", getEventJudges);
router.get("/events/:id/judges/:judgeId", getEventJudge);

// ============ Handlers ============

async function assignJudges(req: Request<IdParams>, res: Response) {
  try {
    const { judgeIds, type } = req.body ?? {};
    const result = await eventJudgeModel.addJudgesToEvent(
      req.params.id,
      judgeIds,
      type,
    );
    res.status(result.added.length > 0 ? 201 : 200).json(result);
  } catch (err) {
    handleError(err, res);
  }
}

async function getEventJudges(req: Request<IdParams>, res: Response) {
  try {
    const { type, hasConflicts, page, limit } = req.query;

    let conflictsFilter: boolean | undefined;
    if (hasConflicts === "true") conflictsFilter = true;
    else if (hasConflicts === "false") conflictsFilter = false;
    else if (hasConflicts !== undefined)
      throw new InvalidInputError(
        "Invalid input: hasConflicts must be true or false",
      );

    const { eventJudges, total } = await eventJudgeModel.getAllEventJudges(
      req.params.id,
      {
        type: typeof type === "string" ? type : undefined,
        hasConflicts: conflictsFilter,
      },
      parsePagination(page, limit),
    );
    res.set("X-Total-Count", String(total));
    res.json(eventJudges);
  } catch (err) {
    handleError(err, res);
  }
}

async function getEventJudge(req: Request<EventJudgeParams>, res: Response) {
  try {
    const result = await eventJudgeModel.getEventJudge(
      req.params.id,
      req.params.judgeId,
    );
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
}
export default router;
