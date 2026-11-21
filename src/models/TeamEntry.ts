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
import * as teamModel from "./Team.js";
import * as awardModel from "./Award.js";

let client: MongoClient;
export let teamEntriesCollection: Collection<TeamEntry>;

const collectionName: string = "teamEntries";

// A team entry means a team applied for an award (a "challenge" in the UI).
// A team can apply for an award only once.
export interface TeamEntry {
  _id?: ObjectId;
  teamId: string;
  awardId: string;
  // A new entry is always "pending"
  status: "pending" | "verified" | "rejected";
  evidence: string[];
  verifiedBy?: string; // id of the user who verified or rejected the entry
  verifiedAt?: Date;
  note?: string;
}

const REVIEW_STATUSES = ["verified", "rejected"] as const;

const ENTRY_STATUSES = ["pending", "verified", "rejected"] as const;

/**
 * Connect to the database and prepare the team entries collection.
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
    teamEntriesCollection = db.collection(collectionName);
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
 * Apply a team for an award. The new entry is "pending".
 * Throws InvalidInputError if the team or the award does not exist, if they
 * are not in the same event, or if the team already applied for the award.
 */
export async function addTeamEntry(
  teamId: string,
  awardId: string,
): Promise<TeamEntry> {
  if (!teamEntriesCollection)
    throw new DatabaseError("Database Collection object not initialized");

  if (!awardId) throw new InvalidInputError("Invalid input: awardId is empty");

  // Both throw InvalidInputError if the id is wrong or not found
  const team = await teamModel.getTeamById(teamId);
  const award = await awardModel.getAwardById(awardId);

  if (team.eventId !== award.eventId)
    throw new InvalidInputError(
      "Invalid input: the team and the award are not in the same event",
    );

  const existing = await teamEntriesCollection.findOne({ teamId, awardId });
  if (existing)
    throw new InvalidInputError(
      `The team already applied for the award '${award.name}'`,
    );

  const entry: TeamEntry = {
    teamId,
    awardId,
    status: "pending",
    evidence: [],
  };

  try {
    await teamEntriesCollection.insertOne(entry);
    return entry;
  } catch (err: unknown) {
    if (err instanceof Error) {
      throw new DatabaseError(
        "Database error: unable to insert team entry; " + err.message,
      );
    } else {
      throw new Error("Unknown error: " + err);
    }
  }
}

//#endregion

//#region Get functions

/**
 * Get one team entry by id.
 * Throws InvalidInputError if the id is malformed or no entry has it.
 */
export async function getTeamEntryById(id: string): Promise<WithId<TeamEntry>> {
  if (!teamEntriesCollection)
    throw new DatabaseError("Database Collection object not initialized");

  if (!id)
    throw new InvalidInputError("Invalid input: must enter a team entry id");

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Get Team Entry: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  try {
    const result = await teamEntriesCollection.findOne({ _id: objectId });
    if (!result) {
      throw new InvalidInputError("No team entry found with the provided id");
    }
    return result;
  } catch (err) {
    if (err instanceof InvalidInputError) throw err;
    else
      throw new DatabaseError(
        `Database Error: issue when trying to retrieve team entry with id ${id}`,
      );
  }
}

/** All the entries of one team. */
export async function getEntriesOfTeam(
  teamId: string,
): Promise<WithId<TeamEntry>[]> {
  if (!teamEntriesCollection)
    throw new DatabaseError("Database Collection object not initialized");
  try {
    return await teamEntriesCollection.find({ teamId }).toArray();
  } catch (err) {
    throw new DatabaseError(
      "Database Error: issue when trying to retrieve the team's entries",
    );
  }
}

/** All the entries of several teams (used by the team list). */
export async function getEntriesOfTeams(
  teamIds: string[],
): Promise<WithId<TeamEntry>[]> {
  if (!teamEntriesCollection)
    throw new DatabaseError("Database Collection object not initialized");
  try {
    return await teamEntriesCollection
      .find({ teamId: { $in: teamIds } })
      .toArray();
  } catch (err) {
    throw new DatabaseError(
      "Database Error: issue when trying to retrieve the teams' entries",
    );
  }
}

/**
 * The ids of the teams that have an entry with this awardId and/or status.
 * Throws InvalidInputError if status is not pending, verified or rejected.
 */
export async function getTeamIdsWithEntry(filter: {
  awardId?: string;
  status?: string;
}): Promise<string[]> {
  if (!teamEntriesCollection)
    throw new DatabaseError("Database Collection object not initialized");

  const { awardId, status } = filter;
  if (status !== undefined && !ENTRY_STATUSES.some((s) => s === status))
    throw new InvalidInputError(
      `Invalid input: verification must be one of ${ENTRY_STATUSES.join(", ")}`,
    );

  const query: Filter<TeamEntry> = {};
  if (awardId) query.awardId = awardId;
  if (status) query.status = status as TeamEntry["status"];

  try {
    return await teamEntriesCollection.distinct("teamId", query);
  } catch (err) {
    throw new DatabaseError(
      "Database Error: issue when trying to filter teams by entry",
    );
  }
}

//#endregion

//#region Update functions

/**
 * Verify or reject a team entry.
 * status must be "verified" or "rejected". note is optional.
 * verifiedBy and verifiedAt are set here, not by the client.
 */
export async function reviewTeamEntry(
  id: string,
  status: unknown,
  note: unknown,
  userId: string,
): Promise<TeamEntry> {
  if (!teamEntriesCollection)
    throw new DatabaseError("Database Collection object not initialized");

  if (!REVIEW_STATUSES.some((s) => s === status))
    throw new InvalidInputError(
      `Invalid input: status must be one of ${REVIEW_STATUSES.join(", ")}`,
    );
  if (note !== undefined && typeof note !== "string")
    throw new InvalidInputError("Invalid input: note must be a string");

  // Throws InvalidInputError if the id is wrong or not found
  const oldEntry = await getTeamEntryById(id);

  const newEntry: TeamEntry = {
    ...oldEntry,
    status: status as TeamEntry["status"],
    verifiedBy: userId,
    verifiedAt: new Date(),
    ...(note !== undefined && { note }),
  };

  try {
    const replaced = await teamEntriesCollection.findOneAndReplace(
      { _id: oldEntry._id },
      newEntry,
    );
    if (!replaced) throw new Error();
    return newEntry;
  } catch (err: unknown) {
    throw new DatabaseError(
      `Update Team Entry Error: failed to review team entry ${id}` +
        (err instanceof Error ? "; " + err.message : ""),
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

export function getCollection(): Collection<TeamEntry> {
  if (!teamEntriesCollection) {
    throw new DatabaseError(
      "Collection is not defined. Db should have been initialized properly before use.",
    );
  }
  return teamEntriesCollection;
}
