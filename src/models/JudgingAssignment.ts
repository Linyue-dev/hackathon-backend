import {
  MongoError,
  Db,
  MongoClient,
  Collection,
  ObjectId,
  WithId,
} from "mongodb";
import { InvalidInputError } from "../errors/InvalidInputError.js";
import { DatabaseError } from "../errors/DatabaseError.js";
import { pickFields } from "../utils/validateUtils.js";
import * as eventModel from "./Event.js";
import * as judgeModel from "./Judge.js";
import * as teamModel from "./Team.js";

let client: MongoClient;
export let judgingAssignmentsCollection: Collection<JudgingAssignment>;

const collectionName: string = "judgingAssignments";

export interface JudgingAssignment {
  _id?: ObjectId;
  eventId: string;
  judgeId: string;
  teamId: string;
  status: "pending" | "in-progress" | "completed";
  createdAt: Date;
  updatedAt: Date;
}

export interface NewJudgingAssignmentInput {
  eventId: string;
  judgeId: string;
  teamId: string;
}

export interface JudgingAssignmentFilter {
  eventId?: string;
  judgeId?: string;
  teamId?: string;
}

const ASSIGNMENT_STATUSES = ["pending", "in-progress", "completed"] as const;

// Ids and eventId/judgeId/teamId can never be changed after creation.
const UPDATABLE_FIELDS = ["status"] as const;

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
 */
export async function addJudgingAssignment(
  input: NewJudgingAssignmentInput,
): Promise<JudgingAssignment> {
  if (!judgingAssignmentsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  const { eventId, judgeId, teamId } = input;

  assertIdString(eventId, "eventId");
  assertIdString(judgeId, "judgeId");
  assertIdString(teamId, "teamId");

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
 * Get assignments, optionally filtered by event, judge and/or team.
 * "My teams" for a judge = filter by judgeId (and eventId).
 */
export async function getAllJudgingAssignments(
  filter: JudgingAssignmentFilter = {},
): Promise<WithId<JudgingAssignment>[]> {
  if (!judgingAssignmentsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  const query: JudgingAssignmentFilter = {};
  if (filter.eventId) query.eventId = filter.eventId;
  if (filter.judgeId) query.judgeId = filter.judgeId;
  if (filter.teamId) query.teamId = filter.teamId;

  try {
    const cursor = judgingAssignmentsCollection.find(query);
    return await cursor.toArray();
  } catch (err) {
    throw new DatabaseError(
      "Database Error: issue when trying to retrieve judging assignments",
    );
  }
}

//#endregion

//#region Update functions

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

  const cleanUpdates = pickFields(updates, UPDATABLE_FIELDS);
  if (Object.keys(cleanUpdates).length === 0)
    throw new InvalidInputError(
      "Update judging assignment error: at least one valid field must be provided",
    );

  if (cleanUpdates.status !== undefined && !isValidStatus(cleanUpdates.status))
    throw new InvalidInputError(
      `Invalid input: status '${String(cleanUpdates.status)}' is not valid`,
    );

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

//#endregion

//#region Delete functions

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

//#endregion
