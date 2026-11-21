import express, { Request, Response } from "express";
import * as teamEntryModel from "../models/TeamEntry.js";
import { handleError } from "../utils/errorHandler.js";
import type { IdParams } from "../utils/types.js";
import { authenticate } from "../middleware/authenticate.js";
import {
  authorizeByTeam,
  authorizeByTeamEntry,
} from "../middleware/authorize.js";

const router = express.Router();
export const routeRoot = "/api/v1";

// ============ Routes ============
router.post(
  "/teams/:id/entries",
  authenticate,
  authorizeByTeam("organizer"),
  createTeamEntry,
);
router.patch(
  "/entries/:id",
  authenticate,
  authorizeByTeamEntry("organizer"),
  reviewTeamEntry,
);

// ============ Handlers ============

/**
 * POST /teams/:id/entries
 * Apply a team for an award by hand. :id is the team id.
 * Body: awardId (required).
 * Returns 201 with the entry (status "pending").
 * Errors: 400 if the team or award does not exist, they are not in the same
 * event, or the team already applied for the award.
 */
async function createTeamEntry(req: Request<IdParams>, res: Response) {
  try {
    const { awardId } = req.body ?? {};
    const entry = await teamEntryModel.addTeamEntry(req.params.id, awardId);
    res.status(201).json(entry);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * PATCH /entries/:id
 * Verify or reject a team entry.
 * Body: status (required): "verified" or "rejected"; note (optional): string.
 * verifiedBy and verifiedAt are set by the backend.
 * Returns 200 with the entry.
 * Errors: 400 invalid status or note, or entry not found.
 */
async function reviewTeamEntry(req: Request<IdParams>, res: Response) {
  try {
    const { status, note } = req.body ?? {};
    const entry = await teamEntryModel.reviewTeamEntry(
      req.params.id,
      status,
      note,
      req.auth!.userId,
    );
    res.json(entry);
  } catch (err) {
    handleError(err, res);
  }
}

export default router;
