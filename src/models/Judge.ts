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

let client: MongoClient;
export let judgesCollection: Collection<Judge>;

const collectionName: string = "judges";

export interface Judge {
  _id?: ObjectId;
  firstName: string;
  lastName: string;
  email?: string;
  affiliation?: string;
  isTechnical: boolean;
  yearsParticipated: number[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Connect to the database and prepare the judges collection.
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
    judgesCollection = db.collection(collectionName);
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

export async function addJudge(
  firstName: string,
  lastName: string,
  email?: string,
  affiliation?: string,
  isTechnical: boolean = false,
  yearsParticipated: number[] = [],
): Promise<Judge> {
  if (!judgesCollection)
    throw new DatabaseError("Database Collection object not initialized");

  if (!firstName)
    throw new InvalidInputError("Invalid input: judge firstName is empty");
  if (!lastName)
    throw new InvalidInputError("Invalid input: judge lastName is empty");

  const now = new Date();
  const judge: Judge = {
    firstName,
    lastName,
    email,
    affiliation,
    isTechnical,
    yearsParticipated,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await judgesCollection.insertOne(judge);
    return judge;
  } catch (err: unknown) {
    if (err instanceof Error) {
      throw new DatabaseError(
        "Database error: unable to insert judge; " + err.message,
      );
    } else {
      throw new Error("Unknown error: " + err);
    }
  }
}

//#endregion

//#region Get functions

export async function getJudgeById(id: string): Promise<WithId<Judge>> {
  if (!judgesCollection)
    throw new DatabaseError("Database Collection object not initialized");

  if (!id) throw new InvalidInputError("Invalid input: must enter a judge id");

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Get Judge: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  try {
    const result = await judgesCollection.findOne({ _id: objectId });
    if (!result) {
      throw new InvalidInputError("No judge found with the provided id");
    }
    return result;
  } catch (err) {
    if (err instanceof InvalidInputError) throw err;
    else
      throw new DatabaseError(
        `Database Error: issue when trying to retrieve judge with id ${id}`,
      );
  }
}

export async function getAllJudges(): Promise<WithId<Judge>[]> {
  if (!judgesCollection)
    throw new DatabaseError("Database Collection object not initialized");

  try {
    const cursor = judgesCollection.find({});
    return await cursor.toArray();
  } catch (err) {
    throw new DatabaseError(
      "Database Error: issue when trying to retrieve all judges",
    );
  }
}

//#endregion

//#region Update functions

export async function updateJudgeById(
  id: string,
  updates: Partial<Omit<Judge, "_id" | "createdAt" | "updatedAt">>,
): Promise<Judge> {
  if (!judgesCollection)
    throw new DatabaseError("Database Collection object not initialized");

  if (Object.keys(updates).length === 0)
    throw new InvalidInputError(
      "Update judge error: at least one field must be provided",
    );

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Update Judge: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  try {
    const oldJudge = await judgesCollection.findOne<Judge>({ _id: objectId });
    if (!oldJudge)
      throw new InvalidInputError(
        `The judge you are trying to update doesn't exist (id ${id})`,
      );

    const newJudge: Judge = {
      ...oldJudge,
      ...updates,
      updatedAt: new Date(),
    };

    const replaced = await judgesCollection.findOneAndReplace(
      { _id: objectId },
      newJudge,
    );
    if (!replaced) throw new Error();
    return newJudge;
  } catch (err: unknown) {
    if (err instanceof InvalidInputError) throw err;
    else if (err instanceof Error)
      throw new DatabaseError(
        `Update Judge Error: failed to update judge ${id}; ${err.message}`,
      );
    else throw new Error("Unknown error " + err);
  }
}

//#endregion

//#region Delete functions

export async function deleteJudgeById(id: string): Promise<Judge> {
  if (!judgesCollection)
    throw new DatabaseError("Database Collection object not initialized");

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Delete Judge: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  try {
    const judgeToDelete = await judgesCollection.findOne<Judge>({
      _id: objectId,
    });
    if (!judgeToDelete)
      throw new InvalidInputError(
        `The judge you were trying to delete doesn't exist (id ${id})`,
      );

    const result = await judgesCollection.deleteOne({ _id: objectId });
    if (!result.acknowledged)
      throw new InvalidInputError(`unable to delete judge ${id}`);

    return judgeToDelete;
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

export function getCollection(): Collection<Judge> {
  if (!judgesCollection) {
    throw new DatabaseError(
      "Collection is not defined. Db should have been initialized properly before use.",
    );
  }
  return judgesCollection;
}
