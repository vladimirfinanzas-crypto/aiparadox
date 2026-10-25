import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_kjdsqzahqvwafbeukviu",
  runtime: "node-24",
  logLevel: "log",
  // The max compute seconds a task is allowed to run. If the task run exceeds this duration, it will be stopped.
  // You can override this on an individual task.
  // See https://trigger.dev/docs/runs/max-duration
  maxDuration: 3600,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  // Every task the app runs has to live in one of these directories. They used
  // to point at a placeholder folder, so a deploy registered only the sample
  // task: the chat agent, the automation runner and the sandbox meter were
  // never uploaded, and a task trigger found nothing to run.
  dirs: ["./trigger"],
});
