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
import { pickFields, toDate } from "../utils/validateUtils.js";

let client: MongoClient;
export let eventsCollection: Collection<Event>;

const collectionName: string = "events";

export interface Event {
  _id?: ObjectId;
  name: string;
  theme?: string;
  description?: string;
  status:
    | "planning"
    | "in-progress"
    | "judging-started"
    | "judging-ended"
    | "complete";
  logoUrl?: string;
  location?: string;
  startDatetime?: Date;
  endDatetime?: Date;
  judgingFormId?: string;
  createdAt: Date;
  updatedAt: Date;
}
const EVENT_STATUSES = [
  "planning",
  "in-progress",
  "judging-started",
  "judging-ended",
  "complete",
] as const;

const UPDATABLE_FIELDS = [
  "name",
  "theme",
  "description",
  "status",
  "logoUrl",
  "location",
  "startDatetime",
  "endDatetime",
  "judgingFormId",
] as const;

function isValidStatus(value: unknown): value is Event["status"] {
  return EVENT_STATUSES.some((s) => s === value);
}
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
export async function addEvent(
  name: string,
  status: string = "planning",
  logoUrl?: string,
  location?: string,
  startDatetime?: Date | string,
  endDatetime?: Date | string,
  judgingFormId?: string,
  theme?: string,
  description?: string,
): Promise<Event> {
  if (!eventsCollection)
    throw new DatabaseError("Database Collection object not initialized");

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
    status,
    logoUrl,
    location,
    startDatetime: start,
    endDatetime: end,
    judgingFormId,
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
 * Get all events in the database.
 */
export async function getAllEvents(): Promise<WithId<Event>[]> {
  if (!eventsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  try {
    const cursor = eventsCollection.find({});
    return await cursor.toArray();
  } catch (err) {
    throw new DatabaseError(
      "Database Error: issue when trying to retrieve all events",
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

  const cleanUpdates = pickFields(updates, UPDATABLE_FIELDS);
  if (Object.keys(cleanUpdates).length === 0)
    throw new InvalidInputError(
      "Update event error: at least one valid field must be provided",
    );

  if (cleanUpdates.status !== undefined && !isValidStatus(cleanUpdates.status))
    throw new InvalidInputError(
      `Invalid input: status '${String(cleanUpdates.status)}' is not valid`,
    );
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
