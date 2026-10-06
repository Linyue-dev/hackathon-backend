import dotenv from "dotenv";
import app from "./app.js";
import * as eventModel from "./models/Event.js";
import * as judgingFormModel from "./models/JudgingForm.js";
import * as judgeModel from "./models/Judge.js";
import * as teamModel from "./models/Team.js";
import * as judgingAssignmentModel from "./models/JudgingAssignment.js";
dotenv.config();

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI as string;
const DB_NAME = "hackathon";

async function startServer() {
  try {
    console.log("Entered start server.");

    if (!MONGO_URI) {
      throw new Error("MONGO_URI environment variable is required");
    }

    await eventModel.initialize(MONGO_URI, DB_NAME, false);
    await judgingFormModel.initialize(MONGO_URI, DB_NAME, false);
    await judgeModel.initialize(MONGO_URI, DB_NAME, false);
    await teamModel.initialize(MONGO_URI, DB_NAME, false);
    await judgingAssignmentModel.initialize(MONGO_URI, DB_NAME, false);

    app.listen(PORT, () => {
      console.log(`✅ Server is running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error(
      "❌ Missing config or failed to initialize databases:",
      error,
    );
  }
}

startServer();
