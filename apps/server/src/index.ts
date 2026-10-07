import { runServer } from "./run";

// `bun start` and `bun dev` land here. The compiled desktop sidecar starts at bin.ts instead.
await runServer();
