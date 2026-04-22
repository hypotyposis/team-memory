import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { api } from "./routes.js";
import { closeDb } from "./db.js";

const app = new Hono();
app.use("*", cors());
app.use("*", logger());
app.get("/health", (c) =>
  c.json({
    status: "ok",
    primitive_batch: process.env.PRIMITIVE_BATCH ?? null,
  }),
);
app.route("/api", api);

const PORT = parseInt(process.env.PORT ?? "3456", 10);
console.log(`Team Memory Backend starting on port ${PORT}`);
serve({ fetch: app.fetch, port: PORT });

process.on("SIGINT", () => { console.log("Shutting down..."); closeDb(); process.exit(0); });
process.on("SIGTERM", () => { closeDb(); process.exit(0); });
