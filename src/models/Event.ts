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
import { DEFAULT_LIMIT, Pagination } from "../utils/pagination.js";

let client: MongoClient;
export let eventsCollection: Collection<Event>;

const collectionName: string = "events";

export interface Address {
  street?: string;
  city?: string;
  province?: string;
  postal?: string;
}

export interface Event {
  _id?: ObjectId;
  name: string;
  theme?: string;
  description?: string;
  address?: Address;
  rooms: string[];
  arrivalNotes?: string;
  status:
    | "draft"
    | "in-progress"
    | "judging-started"
    | "judging-ended"
    | "complete";
  // The three timestamps below are set by the system (start/end judging,
  // publish results), never directly by the client.
  judgingStartedAt?: Date;
  judgingEndedAt?: Date;
  resultsPublishedAt?: Date;
  logoUrl?: string;
  location?: string;
  startDatetime?: Date;
  endDatetime?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewEventInput {
  name: string;
  status?: string;
  theme?: string;
  description?: string;
  address?: Address;
  rooms?: string[];
  arrivalNotes?: string;
  logoUrl?: string;
  location?: string;
  startDatetime?: Date | string;
  endDatetime?: Date | string;
}

export interface EventFilter {
  status?: string;
  search?: string;
}

// Status flow: draft -> in-progress -> judging-started -> judging-ended -> complete
// "draft" and "in-progress" are set by editing the event.
// "judging-started" and "judging-ended" are set only by startJudging/endJudging.
// "complete" will be set when results are published.
const EVENT_STATUSES = [
  "draft",
  "in-progress",
  "judging-started",
  "judging-ended",
  "complete",
] as const;

// judgingStartedAt, judgingEndedAt and resultsPublishedAt are not listed here
// on purpose: only the start/end/publish actions may write them.
const UPDATABLE_FIELDS = [
  "name",
  "theme",
  "description",
  "address",
  "rooms",
  "arrivalNotes",
  "status",
  "logoUrl",
  "location",
  "startDatetime",
  "endDatetime",
] as const;

/**
 * Connect to the database and prepare the events collection.
 * @param url The MongoDB connection URL.
 * @param dbName The name of the database to initialize.
 * @param resetFlag If true, resets the contents of the collection.
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
    eventsCollection = db.collection(collectionName);
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
 * Add a new event to the database.
 */
export async function addEvent(input: NewEventInput): Promise<Event> {
  if (!eventsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  const {
    name,
    status = "draft",
    theme,
    description,
    address,
    rooms,
    arrivalNotes,
    logoUrl,
    location,
    startDatetime,
    endDatetime,
  } = input;

  if (!name) throw new InvalidInputError("Invalid input: event name is empty");

  if (!isValidStatus(status))
    throw new InvalidInputError(
      `Invalid input: status '${status}' is not valid`,
    );

  const start = toDate(startDatetime);
  const end = toDate(endDatetime);
  if (start && end && end < start)
    throw new InvalidInputError(
      "Invalid input: endDatetime must be after startDatetime",
    );

  const now = new Date();
  const event: Event = {
    name,
    theme,
    description,
    address: address === undefined ? undefined : validateAddress(address),
    rooms: rooms === undefined ? [] : validateRooms(rooms),
    arrivalNotes,
    status,
    logoUrl,
    location,
    startDatetime: start,
    endDatetime: end,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await eventsCollection.insertOne(event);
    return event;
  } catch (err: unknown) {
    if (err instanceof Error) {
      throw new DatabaseError(
        "Database error: unable to insert event; " + err.message,
      );
    } else {
      throw new Error("Unknown error: " + err);
    }
  }
}

//#endregion

//#region Get functions

/**
 * Get an event by its id.
 */
export async function getEventById(id: string): Promise<WithId<Event>> {
  if (!eventsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  if (!id) throw new InvalidInputError("Invalid input: must enter an event id");

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Get Event: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  try {
    const result = await eventsCollection.findOne({ _id: objectId });
    if (!result) {
      throw new InvalidInputError("No event found with the provided id");
    }
    return result;
  } catch (err) {
    if (err instanceof InvalidInputError) throw err;
    else
      throw new DatabaseError(
        `Database Error: issue when trying to retrieve event with id ${id}`,
      );
  }
}

/**
 * Get events, optionally filtered by status and/or name, one page at a time.
 * status can be one of our statuses (e.g. "judging-started") or one of the
 * dashboard groups: draft, upcoming, active, past.
 * @returns the events of the requested page and the total number of matches.
 */
export async function getAllEvents(
  filter: EventFilter = {},
  pagination: Pagination = { page: 1, limit: DEFAULT_LIMIT, skip: 0 },
): Promise<{ events: WithId<Event>[]; total: number }> {
  if (!eventsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  const query = buildEventQuery(filter);

  try {
    const events = await eventsCollection
      .find(query)
      .sort({ createdAt: -1, _id: 1 }) // stable order, so pages never overlap
      .skip(pagination.skip)
      .limit(pagination.limit)
      .toArray();
    const total = await eventsCollection.countDocuments(query);
    return { events, total };
  } catch (err) {
    throw new DatabaseError(
      "Database Error: issue when trying to retrieve events; " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

//#endregion

//#region Update functions

/**
 * Update the properties of an event. Only provided fields are changed.
 */
export async function updateEventById(
  id: string,
  updates: Partial<Omit<Event, "_id" | "createdAt" | "updatedAt">>,
): Promise<Event> {
  if (!eventsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Update Event: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  assertOnlyAllowedFields(updates, UPDATABLE_FIELDS);

  const cleanUpdates = pickFields(updates, UPDATABLE_FIELDS);
  if (Object.keys(cleanUpdates).length === 0)
    throw new InvalidInputError(
      "Update event error: at least one valid field must be provided",
    );

  if (cleanUpdates.status !== undefined && !isValidStatus(cleanUpdates.status))
    throw new InvalidInputError(
      `Invalid input: status '${String(cleanUpdates.status)}' is not valid`,
    );

  // Judging and results statuses can only change through their own actions,
  // so the timestamps (judgingStartedAt, ...) always match the status.
  if (
    cleanUpdates.status !== undefined &&
    cleanUpdates.status !== "draft" &&
    cleanUpdates.status !== "in-progress"
  )
    throw new InvalidInputError(
      "Invalid input: judging and results statuses are set by their own actions, not by editing the event",
    );

  if (cleanUpdates.address !== undefined)
    cleanUpdates.address = validateAddress(cleanUpdates.address);

  if (cleanUpdates.rooms !== undefined)
    cleanUpdates.rooms = validateRooms(cleanUpdates.rooms);

  if (cleanUpdates.startDatetime !== undefined)
    cleanUpdates.startDatetime = toDate(cleanUpdates.startDatetime);

  if (cleanUpdates.endDatetime !== undefined)
    cleanUpdates.endDatetime = toDate(cleanUpdates.endDatetime);

  try {
    const oldEvent = await eventsCollection.findOne<Event>({ _id: objectId });
    if (!oldEvent)
      throw new InvalidInputError(
        `The event you are trying to update doesn't exist (id ${id})`,
      );

    const newEvent: Event = {
      ...oldEvent,
      ...cleanUpdates,
      updatedAt: new Date(),
    };

    if (
      newEvent.startDatetime &&
      newEvent.endDatetime &&
      newEvent.endDatetime < newEvent.startDatetime
    )
      throw new InvalidInputError(
        "Invalid input: endDatetime must be after startDatetime",
      );

    const replaced = await eventsCollection.findOneAndReplace(
      { _id: objectId },
      newEvent,
    );
    if (!replaced) throw new Error();
    return newEvent;
  } catch (err: unknown) {
    if (err instanceof InvalidInputError) throw err;
    else if (err instanceof Error)
      throw new DatabaseError(
        `Update Event Error: failed to update event ${id}; ${err.message}`,
      );
    else throw new Error("Unknown error " + err);
  }
}

/**
 * Open judging for an event: status becomes "judging-started" and the time is recorded.
 * Allowed from "draft" or "in-progress". It cannot be started twice, and not after it ended.
 */
export async function startJudging(id: string): Promise<WithId<Event>> {
  const event = await getEventById(id);
  if (
    event.status === "judging-started" ||
    event.status === "judging-ended" ||
    event.status === "complete"
  )
    throw new InvalidInputError(
      `Judging cannot be started (current status: ${event.status})`,
    );
  return saveEventChanges(event._id, {
    status: "judging-started",
    judgingStartedAt: new Date(),
  });
}

/**
 * Close judging for an event: status becomes "judging-ended" and the time is recorded.
 * Only allowed while judging is open. Scores will be locked after this.
 */
export async function endJudging(id: string): Promise<WithId<Event>> {
  const event = await getEventById(id);
  if (event.status !== "judging-started")
    throw new InvalidInputError(
      `Judging can only be ended while it is open (current status: ${event.status})`,
    );
  return saveEventChanges(event._id, {
    status: "judging-ended",
    judgingEndedAt: new Date(),
  });
}
//#endregion

//#region Delete functions

/**
 * Delete an event from the database.
 */
export async function deleteEventById(id: string): Promise<Event> {
  if (!eventsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Delete Event: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  try {
    const eventToDelete = await eventsCollection.findOne<Event>({
      _id: objectId,
    });
    if (!eventToDelete)
      throw new InvalidInputError(
        `The event you were trying to delete doesn't exist (id ${id})`,
      );

    const result = await eventsCollection.deleteOne({ _id: objectId });
    if (!result.acknowledged)
      throw new InvalidInputError(`unable to delete event ${id}`);

    return eventToDelete;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    else if (err instanceof InvalidInputError) throw err;
    else if (err instanceof Error)
      throw new Error(`Unexpected error: ${err.message}`);
    else throw new Error(`Unknown error: ${err}`);
  }
}

//#endregion

/**
 * Close the db client.
 */
export async function close() {
  try {
    await client.close();
    console.log("MongoDb connection closed");
  } catch (err: unknown) {
    if (err instanceof Error) console.error(err.message);
    else console.error("Unknown error while attempting to close client");
  }
}

/** Function used only for unit testing purposes */
export function getCollection(): Collection<Event> {
  if (!eventsCollection) {
    throw new DatabaseError(
      "Collection is not defined. Db should have been initialized properly before use.",
    );
  }
  return eventsCollection;
}
//#region Helpers
function isValidStatus(value: unknown): value is Event["status"] {
  return EVENT_STATUSES.some((s) => s === value);
}

function validateRooms(rooms: unknown): string[] {
  if (
    !Array.isArray(rooms) ||
    rooms.some((r) => typeof r !== "string" || !r.trim())
  )
    throw new InvalidInputError(
      "Invalid input: rooms must be an array of non-empty strings",
    );
  return rooms.map((r: string) => r.trim());
}

function validateAddress(address: unknown): Address {
  if (typeof address !== "object" || address === null || Array.isArray(address))
    throw new InvalidInputError("Invalid input: address must be an object");

  const { street, city, province, postal } = address as Record<string, unknown>;
  const fields = { street, city, province, postal };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && typeof value !== "string")
      throw new InvalidInputError(
        `Invalid input: address.${key} must be a string`,
      );
  }
  return fields as Address;
}

/**
 * Apply changes to one event and return the updated document.
 * Used by the action functions (start/end judging), which write system-set
 * fields that updateEventById is not allowed to change.
 */
async function saveEventChanges(
  objectId: ObjectId,
  changes: Partial<Omit<Event, "_id" | "createdAt" | "updatedAt">>,
): Promise<WithId<Event>> {
  try {
    const updated = await eventsCollection.findOneAndUpdate(
      { _id: objectId },
      { $set: { ...changes, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!updated) throw new DatabaseError("Unable to update the event");
    return updated;
  } catch (err: unknown) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(
      "Update Event Error: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Turn the list filter into a MongoDB query.
 * draft/upcoming/active/past are not stored; they are worked out from status and dates.
 */
function buildEventQuery(filter: EventFilter): Filter<Event> {
  const query: Filter<Event> = {};
  const now = new Date();
  const { status, search } = filter;

  if (status !== undefined) {
    if (isValidStatus(status)) {
      query.status = status;
    } else if (status === "upcoming") {
      query.status = { $ne: "draft" };
      query.startDatetime = { $gt: now };
    } else if (status === "active") {
      query.status = { $ne: "draft" };
      query.startDatetime = { $lte: now };
      query.endDatetime = { $gte: now };
    } else if (status === "past") {
      query.status = { $ne: "draft" };
      query.$or = [{ endDatetime: { $lt: now } }, { status: "complete" }];
    } else {
      throw new InvalidInputError(
        `Invalid input: status '${status}' is not valid`,
      );
    }
  }

  if (search) {
    // Escape special characters so the search text is matched literally
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.name = { $regex: escaped, $options: "i" };
  }

  return query;
}
//#endregion
