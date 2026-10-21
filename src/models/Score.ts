import { MongoError, Db, MongoClient, Collection, ObjectId } from "mongodb";
import { InvalidInputError } from "./../errors/InvalidInputError.js";
import { DatabaseError } from "./../errors/DatabaseError.js";
import { AppError } from "../errors/AppError.js";
import * as eventModel from "./Event.js";
import * as judgeModel from "./Judge.js";
import * as teamModel from "./Team.js";
import * as awardModel from "./Award.js";
import * as judgingAssignmentModel from "./JudgingAssignment.js";

let client: MongoClient;
export let scoresCollection: Collection<Score>;

const collectionName: string = "scores";

export interface CriterionScore {
  criterionId: string;
  value: number;
}

export interface CriterionComment {
  category: string;
  comment: string;
}

// One document per judge + team + award.
export interface Score {
  _id?: ObjectId;
  eventId: string;
  teamId: string;
  judgeId: string;
  awardId: string;
  criteriaScores: CriterionScore[];
  comments: CriterionComment[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

// What the API returns for one award of one team
export interface ScoreView {
  awardId: string;
  criteriaScores: CriterionScore[];
  comments: CriterionComment[];
  version: number;
  updatedAt: Date;
}

interface DraftItem {
  awardId: string;
  criteriaScores: CriterionScore[];
  comments: CriterionComment[];
}

/**
 * Connect to the database and prepare the scores collection.
 */
export async function initialize(
  url: string,
  dbName: string,
  resetFlag: boolean,
): Promise<void> {
  try {
    client = new MongoClient(url);
    await client.connect();
    console.log(`Connected to MongoDB - ${collectionName} collection ready`);
    const db: Db = client.db(dbName);

    const collectionCursor = db.listCollections({ name: collectionName });
    const collectionArray = await collectionCursor.toArray();

    if (resetFlag && collectionArray.length > 0) {
      await db.collection(collectionName).drop();
    }
    if (resetFlag || collectionArray.length == 0) {
      const collation = { locale: "en", strength: 1 };
      await db.createCollection(collectionName, { collation: collation });
    }
    scoresCollection = db.collection(collectionName);
    // One score document per judge, team and award
    await scoresCollection.createIndex(
      { teamId: 1, judgeId: 1, awardId: 1 },
      { unique: true },
    );
  } catch (err: unknown) {
    if (err instanceof MongoError) {
      console.error("MongoDB connection failed:", err);
    } else if (err instanceof Error) {
      console.error("Unexpected error:", err);
    } else {
      console.error("Unknown error:", err);
    }
  }
}

//#region Save functions

/**
 * Save the draft scores of one judge for one team.
 * The body is a list with one item per award. Each award in the list is
 * replaced as a whole; awards that are not in the list are left untouched.
 * Partial criteria and decimal values are allowed, so it is safe to repeat.
 */
export async function saveDraftScores(
  teamId: string,
  judgeId: string,
  body: unknown,
): Promise<ScoreView[]> {
  if (!scoresCollection)
    throw new DatabaseError("Database Collection object not initialized");

  if (!Array.isArray(body) || body.length === 0)
    throw new InvalidInputError(
      "Invalid input: body must be a non-empty list of award scores",
    );

  // Each of these throws InvalidInputError if the record does not exist
  const team = await teamModel.getTeamById(teamId);
  await judgeModel.getJudgeById(judgeId);

  const assignment = await judgingAssignmentModel.findAssignment(
    team.eventId,
    judgeId,
    teamId,
  );
  if (!assignment)
    throw new InvalidInputError("This judge is not assigned to this team");

  await assertJudgingOpen(team.eventId);

  // Check every item before anything is saved
  const items = await validateItems(body, team.eventId);

  const now = new Date();
  try {
    await Promise.all(
      items.map((item) =>
        scoresCollection.updateOne(
          { teamId, judgeId, awardId: item.awardId },
          {
            $set: {
              eventId: team.eventId,
              criteriaScores: item.criteriaScores,
              comments: item.comments,
              updatedAt: now,
            },
            $setOnInsert: { version: 1, createdAt: now },
          },
          { upsert: true },
        ),
      ),
    );
  } catch (err: unknown) {
    throw new DatabaseError(
      "Database error: unable to save scores" +
        (err instanceof Error ? "; " + err.message : ""),
    );
  }

  return readScores(teamId, judgeId);
}

//#endregion

//#region Get functions

/**
 * Get the raw scores of one judge for one team, one item per award.
 * Returns an empty list if the judge has not scored anything yet.
 */
export async function getRawScores(
  teamId: string,
  judgeId: string,
): Promise<ScoreView[]> {
  if (!scoresCollection)
    throw new DatabaseError("Database Collection object not initialized");

  // Each of these throws InvalidInputError if the record does not exist
  await teamModel.getTeamById(teamId);
  await judgeModel.getJudgeById(judgeId);

  return readScores(teamId, judgeId);
}

//#endregion

export async function close() {
  try {
    await client.close();
    console.log("MongoDb connection closed");
  } catch (err: unknown) {
    if (err instanceof Error) console.error(err.message);
    else console.error("Unknown error while attempting to close client");
  }
}

export function getCollection(): Collection<Score> {
  if (!scoresCollection) {
    throw new DatabaseError(
      "Collection is not defined. Db should have been initialized properly before use.",
    );
  }
  return scoresCollection;
}

//#region Helpers

async function readScores(
  teamId: string,
  judgeId: string,
): Promise<ScoreView[]> {
  try {
    const docs = await scoresCollection
      .find({ teamId, judgeId })
      .sort({ createdAt: 1, _id: 1 })
      .toArray();
    return docs.map((d) => ({
      awardId: d.awardId,
      criteriaScores: d.criteriaScores,
      comments: d.comments,
      version: d.version,
      updatedAt: d.updatedAt,
    }));
  } catch (err) {
    throw new DatabaseError(
      "Database Error: issue when trying to retrieve scores",
    );
  }
}

/**
 * Scores can only be written while the event's judging is running.
 */
async function assertJudgingOpen(eventId: string): Promise<void> {
  const event = await eventModel.getEventById(eventId);
  if (event.status === "judging-started") return;
  if (event.status === "judging-ended" || event.status === "complete")
    throw new AppError(
      423,
      "judging_closed",
      "Judging has ended for this event",
    );
  throw new AppError(
    409,
    "judging_not_started",
    "Judging has not started for this event",
  );
}

async function validateItems(
  body: unknown[],
  eventId: string,
): Promise<DraftItem[]> {
  const seen = new Set<string>();
  const result: DraftItem[] = [];

  for (let i = 0; i < body.length; i++) {
    const n = i + 1;
    const raw = body[i];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new InvalidInputError(`Invalid input: item ${n} must be an object`);

    const { awardId, criteriaScores, comments } = raw as Record<
      string,
      unknown
    >;
    if (typeof awardId !== "string" || !awardId)
      throw new InvalidInputError(`Invalid input: item ${n} needs an awardId`);
    if (seen.has(awardId))
      throw new InvalidInputError(
        `Invalid input: award '${awardId}' appears more than once`,
      );
    seen.add(awardId);

    // Throws InvalidInputError if the award does not exist
    const award = await awardModel.getAwardById(awardId);
    if (award.eventId !== eventId)
      throw new InvalidInputError(
        `Invalid input: item ${n} award does not belong to this event`,
      );
    if (award.judgedBy !== "judge")
      throw new InvalidInputError(
        `Invalid input: item ${n} award is not judged by judges`,
      );

    result.push({
      awardId,
      criteriaScores: normalizeCriteriaScores(
        criteriaScores,
        award.criteria,
        n,
      ),
      comments: normalizeComments(comments, n),
    });
  }
  return result;
}

function normalizeCriteriaScores(
  value: unknown,
  criteria: awardModel.CriteriaItem[],
  n: number,
): CriterionScore[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new InvalidInputError(
      `Invalid input: item ${n} criteriaScores must be an array`,
    );

  const used = new Set<string>();
  return value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new InvalidInputError(
        `Invalid input: item ${n} has a criteria score that is not an object`,
      );
    const { criterionId, value: score } = entry as Record<string, unknown>;

    const criterion = criteria.find((c) => c.id === criterionId);
    if (typeof criterionId !== "string" || !criterion)
      throw new InvalidInputError(
        `Invalid input: item ${n} has a criterionId that does not belong to this award`,
      );
    if (used.has(criterionId))
      throw new InvalidInputError(
        `Invalid input: item ${n} scores criterion '${criterionId}' more than once`,
      );
    used.add(criterionId);

    if (typeof score !== "number" || !Number.isFinite(score))
      throw new InvalidInputError(
        `Invalid input: item ${n} value for '${criterionId}' must be a number`,
      );
    if (score < 0 || score > criterion.max)
      throw new InvalidInputError(
        `Invalid input: item ${n} value for '${criterionId}' must be between 0 and ${criterion.max}`,
      );

    return { criterionId, value: score };
  });
}

function normalizeComments(value: unknown, n: number): CriterionComment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new InvalidInputError(
      `Invalid input: item ${n} comments must be an array`,
    );

  return value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new InvalidInputError(
        `Invalid input: item ${n} has a comment that is not an object`,
      );
    const { category, comment } = entry as Record<string, unknown>;
    if (typeof category !== "string" || !category.trim())
      throw new InvalidInputError(
        `Invalid input: item ${n} has a comment without a category`,
      );
    if (typeof comment !== "string")
      throw new InvalidInputError(
        `Invalid input: item ${n} comment text must be a string`,
      );
    return { category: category.trim(), comment };
  });
}

//#endregion
