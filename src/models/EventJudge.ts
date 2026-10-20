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

//#endregion
