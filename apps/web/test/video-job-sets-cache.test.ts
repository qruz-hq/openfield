// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { beforeEach, expect, test } from "bun:test";
import type { JobSetWithJobs } from "@openfield/core";
import { queryClient, queryKeys } from "../src/api/client";
import { applyEvent } from "../src/api/events";
import { addJobSet } from "../src/api/hooks/job-sets";
import { at, jobSet } from "./fixtures";

// The Image and Video feeds cache their own modality's runs (§0.16): a run of one kind never
// shows on the other's list, whichever of the stream or the 202 fills the cache first.

const imageList = () => queryClient.getQueryData<JobSetWithJobs[]>(queryKeys.jobSets("image")) ?? [];
const videoList = () => queryClient.getQueryData<JobSetWithJobs[]>(queryKeys.jobSets("video")) ?? [];

beforeEach(() => {
  queryClient.setQueryData<JobSetWithJobs[]>(queryKeys.jobSets("image"), []);
  queryClient.setQueryData<JobSetWithJobs[]>(queryKeys.jobSets("video"), []);
});

test("a video run lands only in the video list", () => {
  const run = jobSet(at(0), ["pending"], { model: "byteplus:seedance-2-0-fast", modality: "video" });
  applyEvent({ event: "job_set.created", data: run });
  expect(videoList().map((s) => s.jobSet.id)).toEqual([run.jobSet.id]);
  expect(imageList()).toEqual([]);
});

test("an image run lands only in the image list", () => {
  const run = jobSet(at(0), ["pending"]);
  applyEvent({ event: "job_set.created", data: run });
  expect(imageList().map((s) => s.jobSet.id)).toEqual([run.jobSet.id]);
  expect(videoList()).toEqual([]);
});

test("the 202 for a video run also lands only in the video list", () => {
  const run = jobSet(at(0), ["pending"], { model: "byteplus:seedance-2-0-fast", modality: "video" });
  addJobSet(run);
  expect(videoList().map((s) => s.jobSet.id)).toEqual([run.jobSet.id]);
  expect(imageList()).toEqual([]);
});

test("job.output patches the run wherever it actually is, image or video", () => {
  const run = jobSet(at(0), ["pending"], { model: "byteplus:seedance-2-0-fast", modality: "video" });
  applyEvent({ event: "job_set.created", data: run });
  applyEvent({
    event: "job.output",
    data: {
      jobSetId: run.jobSet.id,
      jobId: run.jobs[0]!.id,
      idx: 0,
      asset: {
        id: "01Kasset0000000000000000",
        kind: "generated",
        jobSetId: run.jobSet.id,
        jobId: run.jobs[0]!.id,
        modality: "video",
        width: 1248,
        height: 704,
        mime: "video/mp4",
        durationMs: 5000,
        hasAudio: true,
        posterUrl: "/files/poster/01Kasset0000000000000000",
        sha256: "0".repeat(64),
        providerId: "byteplus",
        modelId: "seedance-2-0-fast",
        prompt: "a kite",
        approximate: false,
        isFavourite: false,
        rerun: false,
        createdAt: at(1),
        thumbUrl: "/files/thumb/01Kasset0000000000000000",
        fileUrl: "/files/asset/01Kasset0000000000000000",
      },
    },
  });
  expect(videoList()[0]!.jobs[0]!.status).toBe("succeeded");
  expect(videoList()[0]!.jobs[0]!.assetId).toBe("01Kasset0000000000000000");
  expect(imageList()).toEqual([]);
});
