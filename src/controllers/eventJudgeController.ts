import express, { Request, Response } from "express";
import { IdParams } from "../utils/types.js";
import * as eventJudgeModel from "./../models/EventJudge.js";
import { handleError } from "../utils/errorHandler.js";
import { InvalidInputError } from "../errors/InvalidInputError.js";
import { parsePagination } from "../utils/pagination.js";
import * as judgingAssignmentModel from "./../models/JudgingAssignment.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import * as eventModel from "../models/Event.js";
import { sendMail } from "../utils/mailService.js";

const router = express.Router();
export const routeRoot = "/api/v1";
type EventJudgeParams = IdParams & { judgeId: string };

// ============ Routes ============
// The id in the path is the event id
router.post(
  "/events/:id/assignJudge",
  authenticate,
  authorize("organizer"),
  assignJudges,
);
router.get(
  "/events/:id/judges",
  authenticate,
  authorize("viewer"),
  getEventJudges,
);
router.get(
  "/events/:id/judges/:judgeId",
  authenticate,
  authorize("viewer"),
  getEventJudge,
);

router.patch(
  "/events/:id/judges/:judgeId",
  authenticate,
  authorize("organizer"),
  updateEventJudge,
);
router.put(
  "/events/:id/judges/:judgeId/conflicts",
  authenticate,
  authorize("organizer"),
  setConflicts,
);
router.delete(
  "/events/:id/removeJudge/:judgeId",
  authenticate,
  authorize("organizer"),
  removeJudge,
);

router.get(
  "/events/:id/all-judges",
  authenticate,
  authorize("organizer"),
  getAllJudges,
);

router.get(
  "/events/:id/judge-codes",
  authenticate,
  authorize("organizer"),
  getJudgeCodes,
);

router.post(
  "/events/:id/judge-code/regenerate",
  authenticate,
  authorize("organizer"),
  regenerateJudgeCodes,
);

// ============ Handlers ============

/**
 * POST /events/:id/assignJudge
 * Add existing judges to an event. :id is the event id.
 * Body: judgeIds (required): list of judge ids.
 *       type (optional, default "technical"): "technical", "beginner" or "design".
 * Judges that are already in the event are skipped, not an error.
 * Returns 201 if at least one judge was added, otherwise 200, with
 * { added: [...], alreadyAdded: [...] }.
 * Note: conflict warnings are not returned yet.
 * Errors: 400 invalid input, event not found or a judge not found.
 */
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

/**
 * GET /events/:id/judges?type=&hasConflicts=&page=&limit=
 * The judges of an event. :id is the event id.
 * type: "technical", "beginner" or "design".
 * hasConflicts: "true" or "false".
 * Each item: { eventId, judgeId, type, awardIds, conflicts, notes, createdAt, progress }.
 * progress: { teams, started, submitted, final } counts of the judge's
 * assignments in this event: all, started, submitted and finally submitted.
 * Returns 200 with a plain array. The total number of matches is in the
 * X-Total-Count response header.
 * Errors: 400 invalid filter value.
 */
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
    const progress = await judgingAssignmentModel.getJudgesProgress(
      req.params.id,
      eventJudges.map((j) => j.judgeId),
    );
    res.set("X-Total-Count", String(total));
    res.json(
      eventJudges.map((j) => ({ ...j, progress: progress.get(j.judgeId) })),
    );
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /events/:id/judges/:judgeId
 * One judge of an event. :id is the event id.
 * Errors: 400 if the judge is not in the event.
 */
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

/**
 * PATCH /events/:id/judges/:judgeId
 * Change a judge's settings in this event. Send only the fields to change.
 * Allowed: type ("technical", "beginner" or "design"), awardIds (list of award
 * ids; each must exist and belong to this event), notes.
 * Returns 200 with the updated event judge.
 * Errors: 400 invalid input, a field that cannot be updated, or the judge is
 * not in the event.
 */
async function updateEventJudge(req: Request<EventJudgeParams>, res: Response) {
  try {
    res.json(
      await eventJudgeModel.updateEventJudge(
        req.params.id,
        req.params.judgeId,
        req.body ?? {},
      ),
    );
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * PUT /events/:id/judges/:judgeId/conflicts
 * Set the teams this judge has a conflict of interest with. The list is
 * replaced as a whole; send an empty list to clear it.
 * Body: teamIds (required): list of team ids; each team must exist and belong
 * to this event. reason (optional): string, stored on every conflict.
 * Returns 200 with the updated event judge.
 * Note: assignments that already exist are not checked or removed.
 * Errors: 400 invalid input or the judge is not in the event.
 */
async function setConflicts(req: Request<EventJudgeParams>, res: Response) {
  try {
    const { teamIds, reason } = req.body ?? {};
    res.json(
      await eventJudgeModel.setConflicts(
        req.params.id,
        req.params.judgeId,
        teamIds,
        reason,
      ),
    );
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * DELETE /events/:id/removeJudge/:judgeId
 * Remove a judge from an event. All of the judge's assignments in this event
 * are deleted too.
 * Returns 200 with { message, eventJudge, releasedAssignments } where
 * releasedAssignments is the number of assignments that were deleted.
 * Errors: 400 if the judge is not in the event.
 */
async function removeJudge(req: Request<EventJudgeParams>, res: Response) {
  try {
    const { id, judgeId } = req.params;
    // Throws InvalidInputError if the judge is not in the event
    const eventJudge = await eventJudgeModel.getEventJudge(id, judgeId);
    // The judge's assignments in this event are released first
    const released = await judgingAssignmentModel.releaseJudgeAssignments(
      id,
      judgeId,
    );
    await eventJudgeModel.removeJudgeFromEvent(id, judgeId);
    res.json({
      message: "Judge removed from the event",
      eventJudge,
      releasedAssignments: released,
    });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /events/:id/judge-codes
 * The login state of every judge of the event. :id is the event id.
 * Returns 200 with a plain array of { judgeId, firstName, lastName, email,
 * hasAccount, hasCode }.
 * hasCode: a code was issued for this event. hasAccount: the judge is linked to
 * a user account; with hasCode false it means the judge uses their own
 * password. Codes are not stored, so they cannot be shown again: issue a new
 * one with POST .../judge-code/regenerate.
 * Errors: 400 if the event does not exist. 401 unauthenticated. 403 forbidden.
 */
async function getJudgeCodes(req: Request<IdParams>, res: Response) {
  try {
    res.json(await eventJudgeModel.getJudgeAccounts(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /events/:id/judge-code/regenerate
 * Issue a new code for the judges of the event and email it to each judge.
 * The code is the judge's password: an earlier code stops working. :id is the
 * event id.
 * Body (optional): { judgeIds: [...] }. Without it, every judge of the event
 * gets a new code.
 * A judge who already has a normal account gets code null: they keep their own
 * password and sign in with it. They are emailed that they were added to the
 * event.
 * Returns 200 with a list of
 * { judgeId, firstName, lastName, email, code, emailSent }.
 * emailSent is false when the email could not be sent; a code is still in this
 * response, so it can be given to the judge by hand.
 * The code is in this response only; it is stored as a hash and cannot be read later.
 * Errors: 400 invalid judgeIds, a judge that is not in the event, or event not
 * found. 401 unauthenticated. 403 forbidden.
 */
async function regenerateJudgeCodes(req: Request<IdParams>, res: Response) {
  try {
    const event = await eventModel.getEventById(req.params.id);
    const issued = await eventJudgeModel.issueJudgeCodes(
      req.params.id,
      req.body?.judgeIds,
    );
    const result = [];
    for (const row of issued) {
      const emailSent = row.code
        ? await sendJudgeCode(event.name, row.email, row.code)
        : await sendJudgeNotice(event.name, row.email);
      result.push({ ...row, emailSent });
    }
    res.set("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /events/:id/all-judges
 * Every judge of the event with all information. :id is the event id.
 * Returns 200 with a plain array of { judgeId, firstName, lastName, email, phone,
 * affiliation, isScience, proficiency, yearsParticipated, type, awardIds,
 * conflicts, notes, hasLoggedIn }.
 * hasLoggedIn: true when the judge has logged in at least once. Judges who
 * logged in before this was recorded show false until their next login.
 * Errors: 400 if the event does not exist. 401 unauthenticated. 403 forbidden.
 */
async function getAllJudges(req: Request<IdParams>, res: Response) {
  try {
    res.json(await eventJudgeModel.getAllJudgesInfo(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
}

// ============ Helpers ============

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Email the code to the judge. Returns false when the email fails. */
async function sendJudgeCode(
  eventName: string,
  email: string,
  code: string,
): Promise<boolean> {
  try {
    await sendMail({
      recipientEmail: email,
      subject: `Your judge code for ${eventName}`,
      text: `You are a judge in ${eventName}.\n\nLog in with this email and this code as the password:\n${code}\n\nThe code works only for this event and stops working when judging ends. A new code replaces this one.`,
      html: `<p>You are a judge in <b>${escapeHtml(eventName)}</b>.</p><p>Log in with this email and this code as the password:</p><h1 style="letter-spacing: 3px;">${code}</h1><p>The code works only for this event and stops working when judging ends. A new code replaces this one.</p>`,
    });
    return true;
  } catch (err) {
    console.error("Unable to send the judge code email:", err);
    return false;
  }
}

/** Email a judge with a normal account that they were added to the event. */
async function sendJudgeNotice(
  eventName: string,
  email: string,
): Promise<boolean> {
  try {
    await sendMail({
      recipientEmail: email,
      subject: `You are a judge in ${eventName}`,
      text: `You were added as a judge in ${eventName}.\n\nLog in with your own account: your email and your password.`,
      html: `<p>You were added as a judge in <b>${escapeHtml(eventName)}</b>.</p><p>Log in with your own account: your email and your password.</p>`,
    });
    return true;
  } catch (err) {
    console.error("Unable to send the judge notice email:", err);
    return false;
  }
}
export default router;
