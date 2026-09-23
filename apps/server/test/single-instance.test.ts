import { afterEach, expect, test } from "bun:test";
import { getJob } from "@openfield/db";
import { createServer, LibraryInUseError } from "../src/server";
import { gatedFetch, generate, saveKey, startTestServer, type TestServer, waitFor } from "./helpers";

// One Openfield per library folder: a second one must not recover or schedule the first one's runs.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

test("a second server on the same library refuses to start and leaves live runs alone", async () => {
  const gate = gatedFetch();
  server = await startTestServer({ fetch: gate.fetch });
  await saveKey(server);
  const accepted = await generate(server);
  const jobId = accepted.jobs[0]!.id;
  await waitFor(() => server!.services.runner.inFlight > 0);

  await expect(
    createServer({ env: { OPENFIELD_HOME: server.home }, console: false, webDist: null }),
  ).rejects.toThrow(LibraryInUseError);

  expect(getJob(server.services.db, jobId)?.status).toBe("submitting");
  gate.release();
});

test("the library is free again once the server stops", async () => {
  server = await startTestServer();
  await server.close({ keepHome: true });
  const again = await startTestServer({ home: server.home });
  server = again;
  expect(again.services.runner).toBeDefined();
});
