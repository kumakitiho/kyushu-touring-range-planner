import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { AppServerCodexProvider, type CodexPlanProvider } from "./codexProvider";
import { buildPlansWithMode } from "./planService";
import { beginRoutingBudget } from "./routing";
import { PlanRequestSchema } from "../src/shared/types";

export function createApp(options: { distPath?: string | false; codexProvider?: CodexPlanProvider } = {}) {
  const app = express();
  const codexProvider = options.codexProvider ?? new AppServerCodexProvider();
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || isAllowedOrigin(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("Origin is not allowed"));
      }
    })
  );
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      providers: {
        openai: false,
        codexAppServer: true,
        openrouteservice: Boolean(process.env.OPENROUTESERVICE_API_KEY),
        localSpots: true,
        fallback: true
      }
    });
  });

  app.get("/api/codex/status", async (_request, response) => {
    response.json(await codexProvider.getStatus());
  });

  app.post("/api/codex/login/start", async (_request, response) => {
    response.json(await codexProvider.startLogin());
  });

  app.post("/api/plans", rateLimitPlans(), async (request, response) => {
    const parsed = PlanRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid plan request", issues: parsed.error.issues });
      return;
    }

    const finishRoutingBudget = beginRoutingBudget(12, 18_000);
    try {
      response.json(await buildPlansWithMode(parsed.data, codexProvider));
    } finally {
      finishRoutingBudget();
    }
  });

  const distPath = options.distPath === false ? "" : options.distPath ?? path.resolve(process.cwd(), "dist");
  if (existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get(/^\/(?!api).*/, (_request, response) => {
      response.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.use((error: Error, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (error.message === "Origin is not allowed") {
      response.status(403).json({ error: "Origin is not allowed" });
      return;
    }
    next(error);
  });

  return app;
}

function isAllowedOrigin(origin: string): boolean {
  const allowed = new Set([
    process.env.CORS_ORIGIN,
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    `http://127.0.0.1:${process.env.PORT || 8787}`,
    `http://localhost:${process.env.PORT || 8787}`
  ]);
  return allowed.has(origin);
}

function rateLimitPlans() {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const limit = Number(process.env.PLAN_RATE_LIMIT_PER_MINUTE || 30);
  return (request: express.Request, response: express.Response, next: express.NextFunction) => {
    const key = request.ip || request.socket.remoteAddress || "unknown";
    const now = Date.now();
    const current = buckets.get(key);
    if (!current || current.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + 60_000 });
      next();
      return;
    }
    current.count += 1;
    if (current.count > limit) {
      response.status(429).json({ error: "Too many plan requests. Please wait a moment." });
      return;
    }
    next();
  };
}
