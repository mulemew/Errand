import { Router, type IRouter } from "express";
  import healthRouter from "./health";
  import tasksRouter from "./tasks";
  import authRouter from "./auth";
  import settingsRouter from "./settings";
  import recorderRouter from "./recorder";
  import savedCredentialsRouter from "./saved-credentials";
  import fingerprintProfilesRouter from "./fingerprint-profiles";
  import proxyProfilesRouter from "./proxy-profiles";
  import providersRouter from "./providers";
  import taskGroupsRouter from "./task-groups";
  import webhookRouter from "./webhook";
  import { requireAuth } from "../middlewares/requireAuth";

  const router: IRouter = Router();

  router.use(healthRouter);
  router.use(authRouter);
  // Webhook triggers carry a per-task bearer token instead of a session — external
  // monitors can't log in — so this must be mounted BEFORE requireAuth. It does its
  // own auth; everything below stays session-protected.
  router.use(webhookRouter);
  router.use(requireAuth);
  // BEFORE tasksRouter: it owns /tasks/reorder, and tasks.ts has /tasks/:id, which
  // matches "reorder" as an id and answers 400 before this router is ever reached.
  router.use(taskGroupsRouter);
  router.use(tasksRouter);
  router.use(settingsRouter);
  router.use(recorderRouter);
  router.use(savedCredentialsRouter);
  router.use(fingerprintProfilesRouter);
  router.use(proxyProfilesRouter);
  router.use(providersRouter);

  export default router;
  