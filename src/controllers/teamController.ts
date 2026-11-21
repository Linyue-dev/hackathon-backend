import express, { Request, Response } from "express";
import * as teamModel from "./../models/Team.js";
import { handleError } from "./../utils/errorHandler.js";
import type { IdParams } from "./../utils/types.js";
import { parsePagination } from "./../utils/pagination.js";
import * as scoreModel from "./../models/Score.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize, authorizeByTeam } from "../middleware/authorize.js";
import * as awardModel from "../models/Award.js";
import * as eventJudgeModel from "../models/EventJudge.js";
import { authorizeJudge, eventFromTeam } from "../middleware/authorize.js";
import * as teamEntryModel from "../models/TeamEntry.js";
import type { TeamEntry } from "../models/TeamEntry.js";
import type { WithId } from "mongodb";
import * as teamImportModel from "../models/TeamImport.js";
import * as eventModel from "../models/Event.js";

const router = express.Router();
export const routeRoot = "/api/v1";

// ============ Routes ============
router.post(
  "/events/:id/teams",
  authenticate,
  authorize("organizer"),
  createTeam,
);
router.get("/events/:id/teams", authenticate, authorize("viewer"), getTeams);
router.get("/teams/:id", authenticate, authorizeByTeam("viewer"), getTeamById);
router.patch(
  "/teams/:id",
  authenticate,
  authorizeByTeam("organizer"),
  updateTeam,
);
router.delete("/teams/:id", authenticate, authorizeByTeam("owner"), deleteTeam);

router.get(
  "/teams/:teamId/allAwardsToJudge/:judgeId",
  authenticate,
  authorizeJudge(eventFromTeam("teamId")),
  getAwardsToJudge,
);

router.post(
  "/events/:id/importTeams/fromCsv",
  authenticate,
  authorize("organizer"),
  express.text({ type: "text/csv", limit: "10mb" }),
  importTeams,
);
router.get(
  "/events/:id/lastImportDiffs",
  authenticate,
  authorize("organizer"),
  getLastImportDiffs,
);

// ============ Handlers ============

/**
 * POST /events/:id/teams
 * Add a team to an event. :id is the event id.
 * Body: name (required). Optional:
 *  - tableNumber: positive integer, unique inside the event
 *  - room, projectUrl, projectDescription: strings
 *  - members: list of { firstName, lastName, email, program, year, school? }
 *  - schools: list of strings
 *  - status: "active" (default), "disqualified" or "withdrawn"
 *  - source: "manual" (default) or "devpost"; devpostId: string
 * Returns 201 with the team.
 * Errors: 400 invalid input, event not found or table number already used.
 */
async function createTeam(req: Request<IdParams>, res: Response) {
  try {
    // The event id comes from the path, not from the body
    const team = await teamModel.addTeam({
      ...req.body,
      eventId: req.params.id,
    });
    res.status(201).json(team);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /events/:id/teams?status=&search=&awardId=&verification=&page=&limit=
 * List the teams of an event, newest first. :id is the event id.
 * status: "active", "disqualified" or "withdrawn".
 * search matches the team name (partial, not case-sensitive).
 * awardId: only the teams that applied for this award.
 * verification: "pending", "verified" or "rejected": only the teams that have
 * an entry with this status (for this award when awardId is also sent).
 * Each team has a list "challenges" (same as on the team page).
 * Returns 200 with a plain array. The total number of matches is in the
 * X-Total-Count response header.
 * Errors: 400 invalid status or verification.
 */
async function getTeams(req: Request<IdParams>, res: Response) {
  try {
    const { status, search, awardId, verification, page, limit } = req.query;

    // Filter by entry only when awardId or verification is sent
    let teamIds: string[] | undefined;
    if (typeof awardId === "string" || typeof verification === "string") {
      teamIds = await teamEntryModel.getTeamIdsWithEntry({
        awardId: typeof awardId === "string" ? awardId : undefined,
        status: typeof verification === "string" ? verification : undefined,
      });
    }

    const { teams, total } = await teamModel.getAllTeams(
      req.params.id,
      {
        status: typeof status === "string" ? status : undefined,
        search: typeof search === "string" ? search : undefined,
        teamIds,
      },
      parsePagination(page, limit),
    );

    const entries = await teamEntryModel.getEntriesOfTeams(
      teams.map((t) => String(t._id)),
    );
    const challenges = await withAwardNames(entries);

    // Total number of matches goes in a header; the body stays a plain array
    res.set("X-Total-Count", String(total));
    res.json(
      teams.map((t) => ({
        ...t,
        challenges: challenges.filter((c) => c.teamId === String(t._id)),
      })),
    );
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /teams/:id
 * The team page: the team's own fields, the challenges it applied for, and
 * the scores so far.
 * Returns 200 with the team and two lists:
 *  - "challenges": [{ _id, awardId, awardName, status, evidence, verifiedBy,
 *    verifiedAt, note }]. awardName is null if the award was deleted.
 *  - "judges": [{ judgeId, judgeName, interimSubmittedAt, finalSubmittedAt,
 *    awards: [{ awardId, criteriaScores, comments, total, maxTotal, version, updatedAt }] }].
 *    Only judges who have saved a score for this team are listed; drafts are
 *    included, and interimSubmittedAt tells whether the judge has submitted.
 * Errors: 400 if the team does not exist.
 */
async function getTeamById(req: Request<IdParams>, res: Response) {
  try {
    const team = await teamModel.getTeamById(req.params.id);
    const entries = await teamEntryModel.getEntriesOfTeam(req.params.id);
    const challenges = await withAwardNames(entries);
    const judges = await scoreModel.getScoresByTeam(req.params.id);
    res.json({ ...team, challenges, judges });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * PATCH /teams/:id
 * Change some fields of a team. Send only the fields to change.
 * Allowed: name, tableNumber, room, members, schools, projectUrl,
 * projectDescription, status. members and schools are replaced as a whole.
 * Not allowed: eventId, source, devpostId, importedAt.
 * Returns 200 with the updated team.
 * Errors: 400 invalid input, a field that cannot be updated, table number
 * already used, or team not found.
 */
async function updateTeam(req: Request<IdParams>, res: Response) {
  try {
    const team = await teamModel.updateTeamById(req.params.id, req.body ?? {});
    res.json(team);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * DELETE /teams/:id
 * Delete a team. Returns 200 with { message, team }.
 * Note: there is no check yet for assignments or scores of the team; the
 * delete rules are still to be decided.
 * Errors: 400 if the team does not exist.
 */
async function deleteTeam(req: Request<IdParams>, res: Response) {
  try {
    const team = await teamModel.deleteTeamById(req.params.id);
    res.json({ message: "Team deleted", team });
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /teams/:teamId/allAwardsToJudge/:judgeId
 * The awards this judge scores for this team: the awards of the team's event
 * with judgedBy "judge". The judge must be in the event.
 * Returns 200 with a plain array of { awardId, formId, name, type } in creation
 * order. formId is the award id: the form is read with GET /awards/:id/form.
 * Note: awards the team did not apply for are not filtered out yet.
 * Errors: 400 if the team or judge does not exist, or the judge is not in the
 * event. 401 unauthenticated. 403 forbidden.
 */
async function getAwardsToJudge(
  req: Request<{ teamId: string; judgeId: string }>,
  res: Response,
) {
  try {
    const { teamId, judgeId } = req.params;
    const team = await teamModel.getTeamById(teamId);
    // Throws InvalidInputError if the judge is not in the event
    await eventJudgeModel.getEventJudge(team.eventId, judgeId);
    const awards = await awardModel.getJudgedAwardsOfEvent(team.eventId);
    res.json(
      awards.map((a) => ({
        awardId: String(a._id),
        formId: String(a._id),
        name: a.name,
        type: a.type,
      })),
    );
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * POST /events/:id/importTeams/fromCsv
 * Import teams from a Devpost CSV export. :id is the event id.
 * Body: the CSV text, with the header Content-Type: text/csv.
 * Draft projects are skipped. A project already imported (same project_id)
 * is updated; a new one is created. Each prize in opt_in_prizes becomes a
 * team entry when the event has an award with that name.
 * Returns 200 with the teams of this CSV.
 * The differences are saved and read with GET /events/:id/lastImportDiffs.
 * Errors: 400 empty or invalid CSV, missing column, or event not found.
 */
async function importTeams(req: Request<IdParams>, res: Response) {
  try {
    const teams = await teamImportModel.importTeamsFromCsv(
      req.params.id,
      req.body,
    );
    res.json(teams);
  } catch (err) {
    handleError(err, res);
  }
}

/**
 * GET /events/:id/lastImportDiffs
 * What changed in the last CSV import of the event:
 * { importedAt, added, updated, missing, unknownPrizes }.
 * Returns 200 with null if the event was never imported.
 * Errors: 400 if the event does not exist.
 */
async function getLastImportDiffs(req: Request<IdParams>, res: Response) {
  try {
    const event = await eventModel.getEventById(req.params.id);
    res.json(event.lastImportDiffs ?? null);
  } catch (err) {
    handleError(err, res);
  }
}

/** Add the award name to each entry. A deleted award gives null. */
async function withAwardNames(entries: WithId<TeamEntry>[]) {
  const awards = await Promise.all(
    entries.map((e) => awardModel.getAwardById(e.awardId).catch(() => null)),
  );
  return entries.map((e, i) => ({ ...e, awardName: awards[i]?.name ?? null }));
}

export default router;
