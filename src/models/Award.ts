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
  escapeRegex,
  pickFields,
} from "../utils/validateUtils.js";
import type { Pagination } from "../utils/pagination.js";
import * as eventModel from "./Event.js";

let client: MongoClient;
export let awardsCollection: Collection<Award>;

const collectionName: string = "awards";

// In the UI an award is called a "challenge".
export interface Award {
  _id?: ObjectId;
  eventId: string;
  name: string;
  type: "top-level" | "mini-challenge";
  judgedBy: "organizer" | "sponsor" | "judge";
  sponsoredBy?: string;
  eligibilityCriteria?: string;
  requiresVerification: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewAwardInput {
  eventId: string;
  name: string;
  type: string;
  judgedBy?: string;
  sponsoredBy?: string;
  eligibilityCriteria?: string;
  requiresVerification?: boolean;
}

const JUDGED_BY = ["organizer", "sponsor", "judge"] as const;
const AWARD_TYPES = ["top-level", "mini-challenge"] as const;

// eventId can never be changed after creation.
const UPDATABLE_FIELDS = [
  "name",
  "type",
  "judgedBy",
  "sponsoredBy",
  "eligibilityCriteria",
  "requiresVerification",
] as const;

/**
 * Connect to the database and prepare the awards collection.
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
    awardsCollection = db.collection(collectionName);
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
 * Add a new award (challenge) to an event.
 */
export async function addAward(input: NewAwardInput): Promise<Award> {
  if (!awardsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  const {
    eventId,
    name,
    type,
    sponsoredBy,
    eligibilityCriteria,
    judgedBy = "judge",
    requiresVerification = false,
  } = input;

  if (!eventId) throw new InvalidInputError("Invalid input: eventId is empty");

  if (typeof name !== "string" || !name.trim())
    throw new InvalidInputError("Invalid input: award name is empty");

  if (!isValidJudgedBy(judgedBy))
    throw new InvalidInputError(
      `Invalid input: judgedBy must be one of ${JUDGED_BY.join(", ")}`,
    );

  if (!isValidType(type))
    throw new InvalidInputError(
      `Invalid input: type must be one of ${AWARD_TYPES.join(", ")}`,
    );

  validateOptionalText(sponsoredBy, "sponsoredBy");
  validateOptionalText(eligibilityCriteria, "eligibilityCriteria");
  validateRequiresVerification(requiresVerification);

  // Throws InvalidInputError if the event does not exist
  await eventModel.getEventById(eventId);
  await assertNameFree(eventId, name.trim());

  const now = new Date();
  const award: Award = {
    eventId,
    name: name.trim(),
    type,
    judgedBy,
    ...(sponsoredBy !== undefined && { sponsoredBy }),
    ...(eligibilityCriteria !== undefined && { eligibilityCriteria }),
    requiresVerification,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await awardsCollection.insertOne(award);
    return award;
  } catch (err: unknown) {
    if (err instanceof Error) {
      throw new DatabaseError(
        "Database error: unable to insert award; " + err.message,
      );
    } else {
      throw new Error("Unknown error: " + err);
    }
  }
}

//#endregion

//#region Get functions

export async function getAwardById(id: string): Promise<WithId<Award>> {
  if (!awardsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  if (!id) throw new InvalidInputError("Invalid input: must enter an award id");

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Get Award: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  try {
    const result = await awardsCollection.findOne({ _id: objectId });
    if (!result) {
      throw new InvalidInputError("No award found with the provided id");
    }
    return result;
  } catch (err) {
    if (err instanceof InvalidInputError) throw err;
    else
      throw new DatabaseError(
        `Database Error: issue when trying to retrieve award with id ${id}`,
      );
  }
}

/**
 * Get the awards of one event, with optional name search and paging.
 * Returns the page of awards and the total number of matches.
 */
export async function getAllAwards(
  eventId: string,
  search: string | undefined,
  pagination: Pagination,
): Promise<{ awards: WithId<Award>[]; total: number }> {
  if (!awardsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  const query: Filter<Award> = { eventId };
  if (search) {
    const escaped = escapeRegex(search);
    query.name = { $regex: escaped, $options: "i" };
  }

  try {
    const [awards, total] = await Promise.all([
      awardsCollection
        .find(query)
        .sort({ createdAt: 1, _id: 1 }) // stable order for paging
        .skip(pagination.skip)
        .limit(pagination.limit)
        .toArray(),
      awardsCollection.countDocuments(query),
    ]);
    return { awards, total };
  } catch (err) {
    throw new DatabaseError(
      "Database Error: issue when trying to retrieve awards",
    );
  }
}

//#endregion

//#region Update functions

export async function updateAwardById(
  id: string,
  updates: Partial<Omit<Award, "_id" | "eventId" | "createdAt" | "updatedAt">>,
): Promise<Award> {
  if (!awardsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Update Award: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  assertOnlyAllowedFields(updates, UPDATABLE_FIELDS);

  const cleanUpdates = pickFields(updates, UPDATABLE_FIELDS);
  if (Object.keys(cleanUpdates).length === 0)
    throw new InvalidInputError(
      "Update award error: at least one valid field must be provided",
    );

  if (cleanUpdates.name !== undefined) {
    if (typeof cleanUpdates.name !== "string" || !cleanUpdates.name.trim())
      throw new InvalidInputError("Invalid input: award name is empty");
    cleanUpdates.name = cleanUpdates.name.trim();
  }

  if (cleanUpdates.type !== undefined && !isValidType(cleanUpdates.type))
    throw new InvalidInputError(
      `Invalid input: type must be one of ${AWARD_TYPES.join(", ")}`,
    );

  if (
    cleanUpdates.judgedBy !== undefined &&
    !isValidJudgedBy(cleanUpdates.judgedBy)
  )
    throw new InvalidInputError(
      `Invalid input: judgedBy must be one of ${JUDGED_BY.join(", ")}`,
    );
  validateOptionalText(cleanUpdates.sponsoredBy, "sponsoredBy");
  validateOptionalText(cleanUpdates.eligibilityCriteria, "eligibilityCriteria");
  if (cleanUpdates.requiresVerification !== undefined)
    validateRequiresVerification(cleanUpdates.requiresVerification);

  try {
    const oldAward = await awardsCollection.findOne<Award>({ _id: objectId });
    if (!oldAward)
      throw new InvalidInputError(
        `The award you are trying to update doesn't exist (id ${id})`,
      );

    if (cleanUpdates.name !== undefined)
      await assertNameFree(oldAward.eventId, cleanUpdates.name, objectId);

    const newAward: Award = {
      ...oldAward,
      ...cleanUpdates,
      updatedAt: new Date(),
    };

    const replaced = await awardsCollection.findOneAndReplace(
      { _id: objectId },
      newAward,
    );
    if (!replaced) throw new Error();
    return newAward;
  } catch (err: unknown) {
    if (err instanceof InvalidInputError) throw err;
    else if (err instanceof Error)
      throw new DatabaseError(
        `Update Award Error: failed to update award ${id}; ${err.message}`,
      );
    else throw new Error("Unknown error " + err);
  }
}

//#endregion

//#region Delete functions

export async function deleteAwardById(id: string): Promise<Award> {
  if (!awardsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Delete Award: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  try {
    const awardToDelete = await awardsCollection.findOne<Award>({
      _id: objectId,
    });
    if (!awardToDelete)
      throw new InvalidInputError(
        `The award you were trying to delete doesn't exist (id ${id})`,
      );

    const result = await awardsCollection.deleteOne({ _id: objectId });
    if (!result.acknowledged)
      throw new InvalidInputError(`unable to delete award ${id}`);

    return awardToDelete;
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

export function getCollection(): Collection<Award> {
  if (!awardsCollection) {
    throw new DatabaseError(
      "Collection is not defined. Db should have been initialized properly before use.",
    );
  }
  return awardsCollection;
}

//#region Helpers

function isValidJudgedBy(value: unknown): value is Award["judgedBy"] {
  return JUDGED_BY.some((j) => j === value);
}

function isValidType(value: unknown): value is Award["type"] {
  return AWARD_TYPES.some((t) => t === value);
}

function validateOptionalText(value: unknown, fieldName: string): void {
  if (value !== undefined && typeof value !== "string")
    throw new InvalidInputError(`Invalid input: ${fieldName} must be a string`);
}

function validateRequiresVerification(value: unknown): void {
  if (typeof value !== "boolean")
    throw new InvalidInputError(
      "Invalid input: requiresVerification must be true or false",
    );
}

/**
 * Make sure no other award in the same event already has this name.
 * @param excludeId the award being updated, so it does not conflict with itself.
 */
async function assertNameFree(
  eventId: string,
  name: string,
  excludeId?: ObjectId,
): Promise<void> {
  const existing = await awardsCollection.findOne({
    eventId,
    name,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  });
  if (existing)
    throw new InvalidInputError(
      `An award named '${name}' already exists in this event`,
    );
}

//#endregion
