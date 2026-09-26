import express from "express";
import expressListEndpoints from "express-list-endpoints";

const app = express();

app.use(express.json());

const controllers: string[] = [
  "eventController.js",
  "judgingFormController.js",
  "judgeController.js",
];

async function registerControllers() {
  for (const controllerName of controllers) {
    try {
      const controllerRoutes = await import(`./controllers/${controllerName}`);
      if (
        controllerRoutes &&
        controllerRoutes.routeRoot &&
        controllerRoutes.default
      ) {
        app.use(controllerRoutes.routeRoot, controllerRoutes.default);
      } else {
        throw new Error(`Invalid controller format: ${controllerName}`);
      }
    } catch (error) {
      console.error("Failed to register controller:", controllerName, error);
      throw error;
    }
  }
}

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

await registerControllers();
console.log(expressListEndpoints(app));

export default app;
