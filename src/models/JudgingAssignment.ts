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
import * as eventJudgeModel from "./EventJudge.js";
import { DEFAULT_LIMIT, Pagination } from "../utils/pagination.js";
import { AppError } from "../errors/AppError.js";

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
  // Set when the judge starts judging this team
  judgingStartTime?: Date;
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
 * The judge must be in the event (EventJudge) and the team must not be one
 * of the judge's conflicts (409 conflict_of_interest).
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

  // The judge must already be in this event (throws InvalidInputError if not)
  const eventJudge = await eventJudgeModel.getEventJudge(eventId, judgeId);

  // Being in the event is fine, but not for a team listed in the judge's conflicts
  if (eventJudge.conflicts.some((c) => c.teamId === teamId))
    throw new AppError(
      409,
      "conflict_of_interest",
      "This judge has a conflict with this team",
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

/**
 * A judge starts judging a team: records judgingStartTime and sets the status
 * to "in-progress". Calling it again changes nothing, and nothing changes if
 * the judge already submitted.
 */
export async function startAssignment(
  judgeId: string,
  teamId: string,
): Promise<WithId<JudgingAssignment>> {
  // Each of these throws InvalidInputError if the record does not exist
  const team = await teamModel.getTeamById(teamId);
  await judgeModel.getJudgeById(judgeId);

  const assignment = await findAssignment(team.eventId, judgeId, teamId);
  if (!assignment)
    throw new InvalidInputError("This judge is not assigned to this team");

  await eventModel.assertJudgingOpen(team.eventId);

  if (assignment.judgingStartTime || assignment.interimSubmittedAt)
    return assignment;

  const now = new Date();
  await getCollection().updateOne(
    { _id: assignment._id },
    { $set: { judgingStartTime: now, status: "in-progress", updatedAt: now } },
  );
  return {
    ...assignment,
    judgingStartTime: now,
    status: "in-progress",
    updatedAt: now,
  };
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

/**
 * What a judge sees when opening an event: who they are, the event, the
 * judging window and how far they are. The judge must be in the event.
 */
export async function getJudgeSession(eventId: string, judgeId: string) {
  // Each of these throws InvalidInputError if the record does not exist
  const event = await eventModel.getEventById(eventId);
  const judge = await judgeModel.getJudgeById(judgeId);
  await eventJudgeModel.getEventJudge(eventId, judgeId);

  const assignments = await findAssignmentsOfJudge(eventId, judgeId);
  return {
    judge: {
      id: judge._id,
      firstName: judge.firstName,
      lastName: judge.lastName,
      email: judge.email,
      affiliation: judge.affiliation,
    },
    event: {
      id: event._id,
      name: event.name,
      theme: event.theme,
      status: event.status,
      judgingStartedAt: event.judgingStartedAt,
      judgingEndedAt: event.judgingEndedAt,
    },
    progress: {
      teams: assignments.length,
      started: assignments.filter((a) => a.judgingStartTime).length,
      submitted: assignments.filter((a) => a.interimSubmittedAt).length,
      final: assignments.filter((a) => a.finalSubmittedAt).length,
    },
  };
}

/**
 * The assignment matrix of an event: its teams, its judges and who is
 * assigned to whom. Teams and judges are always in the same order.
 */
export async function getAssignmentMatrix(eventId: string) {
  // Throws InvalidInputError if the event does not exist
  await eventModel.getEventById(eventId);

  const [teams, eventJudges, assignments] = await Promise.all([
    teamModel
      .getCollection()
      .find({ eventId })
      .sort({ tableNumber: 1, name: 1, _id: 1 })
      .toArray(),
    eventJudgeModel.getCollection().find({ eventId }).toArray(),
    getCollection().find({ eventId }).toArray(),
  ]);

  const judges = await judgeModel
    .getCollection()
    .find({ _id: { $in: eventJudges.map((e) => new ObjectId(e.judgeId)) } })
    .toArray();
  judges.sort(
    (a, b) =>
      a.lastName.localeCompare(b.lastName) ||
      a.firstName.localeCompare(b.firstName) ||
      a._id.toString().localeCompare(b._id.toString()),
  );
  const eventJudgeById = new Map(eventJudges.map((e) => [e.judgeId, e]));

  return {
    teams: teams.map((t) => ({
      id: t._id,
      name: t.name,
      tableNumber: t.tableNumber,
      room: t.room,
      status: t.status,
    })),
    judges: judges.map((j) => {
      const id = j._id.toString();
      const eventJudge = eventJudgeById.get(id);
      return {
        id: j._id,
        firstName: j.firstName,
        lastName: j.lastName,
        type: eventJudge?.type,
        awardIds: eventJudge?.awardIds ?? [],
        // How many teams this judge is assigned to
        workload: assignments.filter((a) => a.judgeId === id).length,
      };
    }),
    assignments: assignments.map((a) => ({
      id: a._id,
      teamId: a.teamId,
      judgeId: a.judgeId,
      slotAt: a.slotAt,
      status: a.status,
    })),
    // Teams each judge must not be assigned to
    conflicts: eventJudges.flatMap((e) =>
      e.conflicts.map((c) => ({
        judgeId: e.judgeId,
        teamId: c.teamId,
        reason: c.reason,
      })),
    ),
  };
}
//#endregion
