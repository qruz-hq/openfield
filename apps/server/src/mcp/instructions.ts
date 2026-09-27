// What an agent reads when it connects (MCP server instructions). Short on purpose: the tool
// descriptions carry the details.

export const INSTRUCTIONS = `Openfield is the person's own image workspace on this computer. It makes images with their own API keys, so every image costs them money.

- Price first. Before making more than one image, or with a model you haven't priced yet, use estimate or dryRun. When a tool says a price needs confirmCost, show the person the price and only go on once they agree. Never raise or work around their limits.
- Models: list_models shows what each can do and costs. Use the person's default model unless they ask for another.
- What you make lands in Openfield's Image feed. Results carry a small preview, the file path and a link that opens the image in Openfield. Give the person the link when you tell them about an image.
- Point at images by their id in the library, a full file path, or a web address. Files and addresses are brought into the library first.
- Tools wait up to "wait" seconds for images. If a run isn't done by then, call wait_for with its runId.
- Folders are labels: an image can be in several. Deleting moves images to the Trash, where they can be restored.
- Only the person can change Openfield's settings and keys, in the app.`;
