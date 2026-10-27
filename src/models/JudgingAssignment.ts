import {
  MongoError,
  Db,
  MongoClient,
  Collection,
  ObjectId,
  WithId,
  Filter,
} from "mongodb";
import { InvalidInputError } from "../errors/InvalidInputError.js";
import { DatabaseError } from "../errors/DatabaseError.js";
import {
  assertOnlyAllowedFields,
  pickFields,
  toDate,
} from "../utils/validateUtils.js";
import * as eventModel from "./Event.js";
import * as judgeModel from "./Judge.js";
import * as teamModel from "./Team.js";
import { DEFAULT_LIMIT, Pagination } from "../utils/pagination.js";

let client: MongoClient;
export let judgingAssignmentsCollection: Collection<JudgingAssignment>;

const collectionName: string = "judgingAssignments";

// One judge assigned to one team in one event (unique per judge + team).
// It also tracks how far the judge is with scoring that team, see the
// submit times below. The scores themselves are in the Score model.
export interface JudgingAssignment {
  _id?: ObjectId;
  eventId: string;
  judgeId: string;
  teamId: string;
  // Starts as "pending". Becomes "completed" at the first submit of scores
  status: "pending" | "in-progress" | "completed";
  // Planned time slot for this judge to visit the team
  slotAt?: Date;
  // Set at the first submit. Scores can then only be changed with PATCH
  interimSubmittedAt?: Date;
  // Set at the final submit. Scores are locked after that
  finalSubmittedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewJudgingAssignmentInput {
  eventId: string;
  judgeId: string;
  teamId: string;
  slotAt?: Date | string;
}

export interface JudgingAssignmentFilter {
  eventId?: string;
  judgeId?: string;
  teamId?: string;
  status?: string;
}

const ASSIGNMENT_STATUSES = ["pending", "in-progress", "completed"] as const;

// Ids and eventId/judgeId/teamId can never be changed after creation.
const UPDATABLE_FIELDS = ["status", "slotAt"] as const;

/**
 * Connect to the database and prepare the judgingAssignments collection.
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
    judgingAssignmentsCollection = db.collection(collectionName);
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

//#region Add functions

/**
 * Assign a judge to a team. Status always starts as "pending".
 * The event, judge and team must exist, the team must belong to the event and
 * be "active", and the same judge cannot be assigned to the same team twice.
 * TODO: also check that the judge is in the event (EventJudge) and that the
 * team is not one of the judge's conflicts.
 */
export async function addJudgingAssignment(
  input: NewJudgingAssignmentInput,
): Promise<JudgingAssignment> {
  if (!judgingAssignmentsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  const { eventId, judgeId, teamId, slotAt } = input;

  assertIdString(eventId, "eventId");
  assertIdString(judgeId, "judgeId");
  assertIdString(teamId, "teamId");
  const slot = toDate(slotAt);
  // Each of these throws InvalidInputError if the record does not exist
  await eventModel.getEventById(eventId);
  await judgeModel.getJudgeById(judgeId);
  const team = await teamModel.getTeamById(teamId);

  if (team.eventId !== eventId)
    throw new InvalidInputError(
      "Invalid input: the team does not belong to this event",
    );
  if (team.status !== "active")
    throw new InvalidInputError(
      `Invalid input: cannot assign a team whose status is '${team.status}'`,
    );

  const existing = await judgingAssignmentsCollection.findOne({
    eventId,
    judgeId,
    teamId,
  });
  if (existing)
    throw new InvalidInputError(
      "This judge is already assigned to this team in this event",
    );

  const now = new Date();
  const assignment: JudgingAssignment = {
    eventId,
    judgeId,
    teamId,
    status: "pending",
    slotAt: slot,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await judgingAssignmentsCollection.insertOne(assignment);
    return assignment;
  } catch (err: unknown) {
    if (err instanceof Error) {
      throw new DatabaseError(
        "Database error: unable to insert judging assignment; " + err.message,
      );
    } else {
      throw new Error("Unknown error: " + err);
    }
  }
}

//#endregion

//#region Get functions

export async function getJudgingAssignmentById(
  id: string,
): Promise<WithId<JudgingAssignment>> {
  if (!judgingAssignmentsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  if (!id)
    throw new InvalidInputError(
      "Invalid input: must enter a judging assignment id",
    );

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Get JudgingAssignment: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  try {
    const result = await judgingAssignmentsCollection.findOne({
      _id: objectId,
    });
    if (!result) {
      throw new InvalidInputError(
        "No judging assignment found with the provided id",
      );
    }
    return result;
  } catch (err) {
    if (err instanceof InvalidInputError) throw err;
    else
      throw new DatabaseError(
        `Database Error: issue when trying to retrieve judging assignment with id ${id}`,
      );
  }
}

/**
 * Get assignments, optionally filtered by event, judge, team and/or status,
 * one page at a time.
 * "My teams" for a judge = filter by judgeId (and eventId).
 * @returns the assignments of the requested page and the total number of matches.
 */
export async function getAllJudgingAssignments(
  filter: JudgingAssignmentFilter = {},
  pagination: Pagination = { page: 1, limit: DEFAULT_LIMIT, skip: 0 },
): Promise<{ assignments: WithId<JudgingAssignment>[]; total: number }> {
  if (!judgingAssignmentsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  const { eventId, judgeId, teamId, status } = filter;
  if (status !== undefined && !isValidStatus(status))
    throw new InvalidInputError(
      `Invalid input: status '${status}' is not valid`,
    );

  const query: Filter<JudgingAssignment> = {};
  if (eventId) query.eventId = eventId;
  if (judgeId) query.judgeId = judgeId;
  if (teamId) query.teamId = teamId;
  if (status) query.status = status;

  try {
    const [assignments, total] = await Promise.all([
      judgingAssignmentsCollection
        .find(query)
        .sort({ createdAt: -1, _id: 1 }) // stable order for paging
        .skip(pagination.skip)
        .limit(pagination.limit)
        .toArray(),
      judgingAssignmentsCollection.countDocuments(query),
    ]);
    return { assignments, total };
  } catch (err) {
    throw new DatabaseError(
      "Database Error: issue when trying to retrieve judging assignments",
    );
  }
}
//#endregion

//#region Update functions

/**
 * Change the status or slotAt of an assignment (partial update, like PATCH).
 * The judge, team and event cannot be changed, and neither can the submit
 * times: those are set only by the Score model when scores are submitted.
 */
export async function updateJudgingAssignmentById(
  id: string,
  updates: Partial<
    Omit<
      JudgingAssignment,
      "_id" | "eventId" | "judgeId" | "teamId" | "createdAt" | "updatedAt"
    >
  >,
): Promise<JudgingAssignment> {
  if (!judgingAssignmentsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Update JudgingAssignment: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  assertOnlyAllowedFields(updates, UPDATABLE_FIELDS);

  const cleanUpdates = pickFields(updates, UPDATABLE_FIELDS);
  if (Object.keys(cleanUpdates).length === 0)
    throw new InvalidInputError(
      "Update judging assignment error: at least one valid field must be provided",
    );

  if (cleanUpdates.status !== undefined && !isValidStatus(cleanUpdates.status))
    throw new InvalidInputError(
      `Invalid input: status '${String(cleanUpdates.status)}' is not valid`,
    );

  if (cleanUpdates.slotAt !== undefined)
    cleanUpdates.slotAt = toDate(cleanUpdates.slotAt);

  try {
    const oldAssignment =
      await judgingAssignmentsCollection.findOne<JudgingAssignment>({
        _id: objectId,
      });
    if (!oldAssignment)
      throw new InvalidInputError(
        `The judging assignment you are trying to update doesn't exist (id ${id})`,
      );

    const newAssignment: JudgingAssignment = {
      ...oldAssignment,
      ...cleanUpdates,
      updatedAt: new Date(),
    };

    const replaced = await judgingAssignmentsCollection.findOneAndReplace(
      { _id: objectId },
      newAssignment,
    );
    if (!replaced) throw new Error();
    return newAssignment;
  } catch (err: unknown) {
    if (err instanceof InvalidInputError) throw err;
    else if (err instanceof Error)
      throw new DatabaseError(
        `Update JudgingAssignment Error: failed to update judging assignment ${id}; ${err.message}`,
      );
    else throw new Error("Unknown error " + err);
  }
}

/**
 * Record the time a judge first submitted their scores for a team, and set
 * the status to "completed". Called by the Score model, not by an endpoint.
 */
export async function markInterimSubmitted(
  id: ObjectId,
  at: Date,
): Promise<void> {
  await getCollection().updateOne(
    { _id: id },
    { $set: { interimSubmittedAt: at, status: "completed", updatedAt: at } },
  );
}

/**
 * Record the time a judge made the final submit for a team. This locks the
 * scores. Called by the Score model, not by an endpoint.
 */
export async function markFinalSubmitted(
  id: ObjectId,
  at: Date,
): Promise<void> {
  await getCollection().updateOne(
    { _id: id },
    { $set: { finalSubmittedAt: at, updatedAt: at } },
  );
}

//#endregion

//#region Delete functions

/**
 * Delete one assignment and return it. Scores already saved for it are not removed.
 */
export async function deleteJudgingAssignmentById(
  id: string,
): Promise<JudgingAssignment> {
  if (!judgingAssignmentsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Delete JudgingAssignment: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  try {
    const toDelete =
      await judgingAssignmentsCollection.findOne<JudgingAssignment>({
        _id: objectId,
      });
    if (!toDelete)
      throw new InvalidInputError(
        `The judging assignment you were trying to delete doesn't exist (id ${id})`,
      );

    const result = await judgingAssignmentsCollection.deleteOne({
      _id: objectId,
    });
    if (!result.acknowledged)
      throw new InvalidInputError(`unable to delete judging assignment ${id}`);

    return toDelete;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    else if (err instanceof InvalidInputError) throw err;
    else if (err instanceof Error)
      throw new Error(`Unexpected error: ${err.message}`);
    else throw new Error(`Unknown error: ${err}`);
  }
}

/**
 * Delete all assignments of a judge in an event. Returns how many were deleted.
 * Used when the judge is removed from the event. Their saved scores are not removed.
 */
export async function releaseJudgeAssignments(
  eventId: string,
  judgeId: string,
): Promise<number> {
  const result = await getCollection().deleteMany({ eventId, judgeId });
  return result.deletedCount;
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

export function getCollection(): Collection<JudgingAssignment> {
  if (!judgingAssignmentsCollection) {
    throw new DatabaseError(
      "Collection is not defined. Db should have been initialized properly before use.",
    );
  }
  return judgingAssignmentsCollection;
}

//#region Helpers

function isValidStatus(value: unknown): value is JudgingAssignment["status"] {
  return ASSIGNMENT_STATUSES.some((s) => s === value);
}

// Request bodies are untyped at runtime, so make sure ids really are strings.
function assertIdString(value: unknown, fieldName: string): void {
  if (typeof value !== "string" || !value)
    throw new InvalidInputError(
      `Invalid input: ${fieldName} must be a non-empty string`,
    );
}

/**
 * Find the assignment of one judge to one team, or null if there is none.
 */
export async function findAssignment(
  eventId: string,
  judgeId: string,
  teamId: string,
): Promise<WithId<JudgingAssignment> | null> {
  return getCollection().findOne({ eventId, judgeId, teamId });
}

/**
 * All assignments of one judge in an event, in time slot order.
 */
export async function findAssignmentsOfJudge(
  eventId: string,
  judgeId: string,
): Promise<WithId<JudgingAssignment>[]> {
  return getCollection()
    .find({ eventId, judgeId })
    .sort({ slotAt: 1, createdAt: 1 })
    .toArray();
}
//#endregion
