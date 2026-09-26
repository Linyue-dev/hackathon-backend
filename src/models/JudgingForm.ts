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
export let judgingFormsCollection: Collection<JudgingForm>;

const collectionName: string = "judgingForms";

export interface CriteriaItem {
  category: string;
  question: string;
  weight: number;
}

export interface JudgingForm {
  _id?: ObjectId;
  name: string;
  instructions?: string;
  criteria: CriteriaItem[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Connect to the database and prepare the judgingForms collection.
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
    judgingFormsCollection = db.collection(collectionName);
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

export async function addJudgingForm(
  name: string,
  criteria: CriteriaItem[],
  instructions?: string,
): Promise<JudgingForm> {
  if (!judgingFormsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  if (!name)
    throw new InvalidInputError("Invalid input: judging form name is empty");

  if (!Array.isArray(criteria) || criteria.length === 0)
    throw new InvalidInputError(
      "Invalid input: criteria must be a non-empty array",
    );

  for (const item of criteria) {
    if (!item.category || !item.question || typeof item.weight !== "number") {
      throw new InvalidInputError(
        "Invalid input: each criteria item needs category, question, and weight",
      );
    }
  }

  const now = new Date();
  const form: JudgingForm = {
    name,
    instructions,
    criteria,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await judgingFormsCollection.insertOne(form);
    return form;
  } catch (err: unknown) {
    if (err instanceof Error) {
      throw new DatabaseError(
        "Database error: unable to insert judging form; " + err.message,
      );
    } else {
      throw new Error("Unknown error: " + err);
    }
  }
}

//#endregion

//#region Get functions

export async function getJudgingFormById(
  id: string,
): Promise<WithId<JudgingForm>> {
  if (!judgingFormsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  if (!id)
    throw new InvalidInputError("Invalid input: must enter a judging form id");

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Get JudgingForm: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  try {
    const result = await judgingFormsCollection.findOne({ _id: objectId });
    if (!result) {
      throw new InvalidInputError("No judging form found with the provided id");
    }
    return result;
  } catch (err) {
    if (err instanceof InvalidInputError) throw err;
    else
      throw new DatabaseError(
        `Database Error: issue when trying to retrieve judging form with id ${id}`,
      );
  }
}

export async function getAllJudgingForms(): Promise<WithId<JudgingForm>[]> {
  if (!judgingFormsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  try {
    const cursor = judgingFormsCollection.find({});
    return await cursor.toArray();
  } catch (err) {
    throw new DatabaseError(
      "Database Error: issue when trying to retrieve all judging forms",
    );
  }
}

//#endregion

//#region Update functions

export async function updateJudgingFormById(
  id: string,
  updates: Partial<Omit<JudgingForm, "_id" | "createdAt" | "updatedAt">>,
): Promise<JudgingForm> {
  if (!judgingFormsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  if (Object.keys(updates).length === 0)
    throw new InvalidInputError(
      "Update judging form error: at least one field must be provided",
    );

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Update JudgingForm: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  try {
    const oldForm = await judgingFormsCollection.findOne<JudgingForm>({
      _id: objectId,
    });
    if (!oldForm)
      throw new InvalidInputError(
        `The judging form you are trying to update doesn't exist (id ${id})`,
      );

    const newForm: JudgingForm = {
      ...oldForm,
      ...updates,
      updatedAt: new Date(),
    };

    const replaced = await judgingFormsCollection.findOneAndReplace(
      { _id: objectId },
      newForm,
    );
    if (!replaced) throw new Error();
    return newForm;
  } catch (err: unknown) {
    if (err instanceof InvalidInputError) throw err;
    else if (err instanceof Error)
      throw new DatabaseError(
        `Update JudgingForm Error: failed to update judging form ${id}; ${err.message}`,
      );
    else throw new Error("Unknown error " + err);
  }
}

//#endregion

//#region Delete functions

export async function deleteJudgingFormById(id: string): Promise<JudgingForm> {
  if (!judgingFormsCollection)
    throw new DatabaseError("Database Collection object not initialized");

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch (err) {
    throw new InvalidInputError(
      `Delete JudgingForm: the id ${id} is not in the valid format (24 hexadecimal characters)`,
    );
  }

  try {
    const formToDelete = await judgingFormsCollection.findOne<JudgingForm>({
      _id: objectId,
    });
    if (!formToDelete)
      throw new InvalidInputError(
        `The judging form you were trying to delete doesn't exist (id ${id})`,
      );

    const result = await judgingFormsCollection.deleteOne({ _id: objectId });
    if (!result.acknowledged)
      throw new InvalidInputError(`unable to delete judging form ${id}`);

    return formToDelete;
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

export function getCollection(): Collection<JudgingForm> {
  if (!judgingFormsCollection) {
    throw new DatabaseError(
      "Collection is not defined. Db should have been initialized properly before use.",
    );
  }
  return judgingFormsCollection;
}
