import {
  MongoError,
  Db,
  MongoClient,
  Collection,
  WithId,
  Filter,
  ObjectId,
} from "mongodb";
import { InvalidInputError } from "../errors/InvalidInputError.js";
import { DatabaseError } from "../errors/DatabaseError.js";
import type { Pagination } from "../utils/pagination.js";
import * as eventModel from "./Event.js";
import * as judgeModel from "./Judge.js";
import * as teamModel from "./Team.js";
import * as awardModel from "./Award.js";
import { assertOnlyAllowedFields, pickFields } from "../utils/validateUtils.js";

let client: MongoClient;
export let eventJudgesCollection: Collection<EventJudge>;

const collectionName: string = "eventJudges";

export interface Conflict {
  teamId: string;
  reason?: string;
}

// Links one judge to one event. The same judge can be in many events.
export interface EventJudge {
  _id?: ObjectId;
  eventId: string;
  judgeId: string;
  type: "technical" | "beginner" | "design";
  awardIds: string[];
  conflicts: Conflict[];
  notes?: string;
  createdAt: Date;
}

export interface EventJudgeFilter {
  type?: string;
  hasConflicts?: boolean;
}

const JUDGE_TYPES = ["technical", "beginner", "design"] as const;

/**
 * Connect to the database and prepare the eventJudges collection.
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
    eventJudgesCollection = db.collection(collectionName);
    // A judge can be added to an event only once
    await eventJudgesCollection.createIndex(
      { eventId: 1, judgeId: 1 },
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

//#region Add functions

/**
 * Add existing judges to an event. Judges already in the event are skipped
 * and reported in alreadyAdded.
 */
export async function addJudgesToEvent(
  eventId: string,
  judgeIds: unknown,
  type: unknown = "technical",
): Promise<{ added: EventJudge[]; alreadyAdded: string[] }> {
  if (!eventJudgesCollection)
    throw new DatabaseError("Database Collection object not initialized");

  if (!Array.isArray(judgeIds) || judgeIds.length === 0)
    throw new InvalidInputError(
      "Invalid input: judgeIds must be a non-empty array",
    );

  if (judgeIds.some((id) => typeof id !== "string"))
    throw new InvalidInputError(
      "Invalid input: every judge id must be a string",
    );

  if (!isValidType(type))
    throw new InvalidInputError(
      `Invalid input: type must be one of ${JUDGE_TYPES.join(", ")}`,
    );

  const uniqueIds = [...new Set(judgeIds as string[])];

  // Each of these throws InvalidInputError if it does not exist
  await eventModel.getEventById(eventId);
  for (const id of uniqueIds) await judgeModel.getJudgeById(id);

  try {
    const existing = await eventJudgesCollection
      .find({ eventId, judgeId: { $in: uniqueIds } })
      .toArray();
    const existingIds = new Set(existing.map((e) => e.judgeId));

    const now = new Date();
    const toAdd: EventJudge[] = uniqueIds
      .filter((id) => !existingIds.has(id))
      .map((judgeId) => ({
        eventId,
        judgeId,
        type,
        awardIds: [],
        conflicts: [],
        createdAt: now,
      }));

    if (toAdd.length > 0) await eventJudgesCollection.insertMany(toAdd);
    return { added: toAdd, alreadyAdded: [...existingIds] };
  } catch (err: unknown) {
    throw new DatabaseError(
      "Database error: unable to add judges to the event" +
        (err instanceof Error ? "; " + err.message : ""),
    );
  }
}

//#endregion

//#region Get functions

/**
 * Get the judges of one event, with optional type / conflicts filters and paging.
 */
export async function getAllEventJudges(
  eventId: string,
  filter: EventJudgeFilter,
  pagination: Pagination,
): Promise<{ eventJudges: WithId<EventJudge>[]; total: number }> {
  if (!eventJudgesCollection)
    throw new DatabaseError("Database Collection object not initialized");

  const query: Filter<EventJudge> = { eventId };
  if (filter.type !== undefined) {
    if (!isValidType(filter.type))
      throw new InvalidInputError(
        `Invalid input: type must be one of ${JUDGE_TYPES.join(", ")}`,
      );
    query.type = filter.type;
  }
  if (filter.hasConflicts === true) query["conflicts.0"] = { $exists: true };
  if (filter.hasConflicts === false) query.conflicts = { $size: 0 };

  try {
    const [eventJudges, total] = await Promise.all([
      eventJudgesCollection
        .find(query)
        .sort({ createdAt: 1, _id: 1 }) // stable order for paging
        .skip(pagination.skip)
        .limit(pagination.limit)
        .toArray(),
      eventJudgesCollection.countDocuments(query),
    ]);
    return { eventJudges, total };
  } catch (err) {
    throw new DatabaseError(
      "Database Error: issue when trying to retrieve the event judges",
    );
  }
}

/**
 * Get one judge of an event.
 */
export async function getEventJudge(
  eventId: string,
  judgeId: string,
): Promise<WithId<EventJudge>> {
  if (!eventJudgesCollection)
    throw new DatabaseError("Database Collection object not initialized");

  try {
    const result = await eventJudgesCollection.findOne({ eventId, judgeId });
    if (!result) throw new InvalidInputError("This judge is not in the event");
    return result;
  } catch (err) {
    if (err instanceof InvalidInputError) throw err;
    throw new DatabaseError(
      `Database Error: issue when trying to retrieve judge ${judgeId} of event ${eventId}`,
    );
  }
}

//#endregion

// eventId and judgeId can never be changed.
const UPDATABLE_FIELDS = ["type", "awardIds", "notes"] as const;

//#region Update functions

/**
 * Edit the type, awards or notes of a judge in an event.
 */
export async function updateEventJudge(
  eventId: string,
  judgeId: string,
  updates: Partial<Pick<EventJudge, "type" | "awardIds" | "notes">>,
): Promise<WithId<EventJudge>> {
  if (!eventJudgesCollection)
    throw new DatabaseError("Database Collection object not initialized");

  assertOnlyAllowedFields(updates, UPDATABLE_FIELDS);
  const cleanUpdates = pickFields(updates, UPDATABLE_FIELDS);
  if (Object.keys(cleanUpdates).length === 0)
    throw new InvalidInputError(
      "Update event judge error: at least one valid field must be provided",
    );

  if (cleanUpdates.type !== undefined && !isValidType(cleanUpdates.type))
    throw new InvalidInputError(
      `Invalid input: type must be one of ${JUDGE_TYPES.join(", ")}`,
    );
  if (
    cleanUpdates.notes !== undefined &&
    typeof cleanUpdates.notes !== "string"
  )
    throw new InvalidInputError("Invalid input: notes must be a string");
  if (cleanUpdates.awardIds !== undefined) {
    cleanUpdates.awardIds = await checkAwardIds(eventId, cleanUpdates.awardIds);
  }

  // Throws InvalidInputError if the judge is not in the event
  await getEventJudge(eventId, judgeId);

  try {
    const saved = await eventJudgesCollection.findOneAndUpdate(
      { eventId, judgeId },
      { $set: cleanUpdates },
      { returnDocument: "after" },
    );
    if (!saved) throw new Error("Judge not found");
    return saved;
  } catch (err: unknown) {
    throw new DatabaseError(
      "Update EventJudge Error: failed to update the judge" +
        (err instanceof Error ? "; " + err.message : ""),
    );
  }
}

/**
 * Replace the conflict teams of a judge. An empty list clears the conflicts.
 * The same reason is stored for every team.
 */
export async function setConflicts(
  eventId: string,
  judgeId: string,
  teamIds: unknown,
  reason?: unknown,
): Promise<WithId<EventJudge>> {
  if (!eventJudgesCollection)
    throw new DatabaseError("Database Collection object not initialized");

  if (!Array.isArray(teamIds) || teamIds.some((id) => typeof id !== "string"))
    throw new InvalidInputError(
      "Invalid input: teamIds must be an array of ids",
    );
  if (reason !== undefined && typeof reason !== "string")
    throw new InvalidInputError("Invalid input: reason must be a string");

  // Throws InvalidInputError if the judge is not in the event
  await getEventJudge(eventId, judgeId);

  const uniqueIds = [...new Set(teamIds as string[])];
  for (const teamId of uniqueIds) {
    const team = await teamModel.getTeamById(teamId);
    if (team.eventId !== eventId)
      throw new InvalidInputError(
        `The team ${teamId} does not belong to this event`,
      );
  }

  const conflicts: Conflict[] = uniqueIds.map((teamId) =>
    reason ? { teamId, reason } : { teamId },
  );

  try {
    const saved = await eventJudgesCollection.findOneAndUpdate(
      { eventId, judgeId },
      { $set: { conflicts } },
      { returnDocument: "after" },
    );
    if (!saved) throw new Error("Judge not found");
    return saved;
  } catch (err: unknown) {
    throw new DatabaseError(
      "Update EventJudge Error: failed to set the conflicts" +
        (err instanceof Error ? "; " + err.message : ""),
    );
  }
}

//#endregion

//#region Delete functions

/**
 * Remove a judge from an event.
 */
export async function removeJudgeFromEvent(
  eventId: string,
  judgeId: string,
): Promise<void> {
  if (!eventJudgesCollection)
    throw new DatabaseError("Database Collection object not initialized");

  try {
    const result = await eventJudgesCollection.deleteOne({ eventId, judgeId });
    if (result.deletedCount === 0)
      throw new InvalidInputError("This judge is not in the event");
  } catch (err) {
    if (err instanceof InvalidInputError) throw err;
    throw new DatabaseError("Database Error: unable to remove the judge");
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

export function getCollection(): Collection<EventJudge> {
  if (!eventJudgesCollection) {
    throw new DatabaseError(
      "Collection is not defined. Db should have been initialized properly before use.",
    );
  }
  return eventJudgesCollection;
}

//#region Helpers

function isValidType(value: unknown): value is EventJudge["type"] {
  return JUDGE_TYPES.some((t) => t === value);
}

/**
 * Every award id must exist and belong to this event. Duplicates are removed.
 */
async function checkAwardIds(
  eventId: string,
  awardIds: unknown,
): Promise<string[]> {
  if (!Array.isArray(awardIds) || awardIds.some((id) => typeof id !== "string"))
    throw new InvalidInputError(
      "Invalid input: awardIds must be an array of ids",
    );

  const uniqueIds = [...new Set(awardIds as string[])];
  for (const awardId of uniqueIds) {
    const award = await awardModel.getAwardById(awardId);
    if (award.eventId !== eventId)
      throw new InvalidInputError(
        `The award ${awardId} does not belong to this event`,
      );
  }
  return uniqueIds;
}
//#endregion
