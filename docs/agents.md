# Agents

AI apps like Claude Code, Claude Desktop, Cursor and Codex can use Openfield for you while it runs: make and edit images, find and file them in your library, check prices and spending. They connect over [MCP](https://modelcontextprotocol.io), the protocol these apps use for tools.

Agents use your API keys but never see them, and only within the limits you set. Everything they make shows up in Openfield like anything you make yourself, with the app's name on it in **Settings > Spending**.

## Turn it on

Agents are off until you turn them on. Open **Settings > Agents** and turn on **Let agents use Openfield**. That makes an **access key**: apps send it with every request, and nothing without it gets in.

Openfield has to be running while an app uses it. Nothing starts it for you.

## Add Openfield to an app

**Settings > Agents > Add to an app** has a ready-made snippet for each app, with your real address, key and folder in it. **Copy** copies it with your whole key; the page only ever shows the key's last four characters.

### Claude Code

Run this in a terminal, then start a new Claude Code session:

```sh
claude mcp add --transport http --scope user openfield http://127.0.0.1:4317/mcp \
  --header "Authorization: Bearer <your access key>"
```

`--scope user` makes Openfield available in every project, not just the folder you ran it in.

### Claude Desktop

Claude Desktop only starts programs, so it uses the bridge: `bun run mcp` in the Openfield folder. It reads the access key from your library folder, so there's nothing to paste. In Claude Desktop, open **Settings > Developer > Edit Config**, add this, then restart Claude:

```json
{
  "mcpServers": {
    "openfield": {
      "command": "/Users/you/.bun/bin/bun",
      "args": ["run", "--silent", "--cwd", "/Users/you/openfield", "mcp"]
    }
  }
}
```

The command is the full path to bun, because desktop apps don't see your shell's `PATH`. The snippet in Settings fills in your own paths, and adds `env` with `OPENFIELD_HOME` or `OPENFIELD_PORT` when yours aren't the defaults.

### Cursor

Add this to `~/.cursor/mcp.json`, then restart Cursor:

```json
{
  "mcpServers": {
    "openfield": {
      "url": "http://127.0.0.1:4317/mcp",
      "headers": { "Authorization": "Bearer <your access key>" }
    }
  }
}
```

### Codex

Add this to `~/.codex/config.toml`, then start Codex again:

```toml
[mcp_servers.openfield]
command = "/Users/you/.bun/bin/bun"
args = ["run", "--silent", "--cwd", "/Users/you/openfield", "mcp"]
```

### Other apps

Apps that connect over HTTP (Streamable HTTP) use `http://127.0.0.1:4317/mcp` with the header `Authorization: Bearer <your access key>`. Apps that start a program run `bun run --silent --cwd <openfield folder> mcp`.

## What agents can do

| Tool | Does |
|---|---|
| `list_models` | The models, what each can do, its sizes and qualities, and its price per image at the speed you chose. |
| `estimate` | What a request would cost, without making anything. |
| `generate_image` | Makes images, or edits one. References and the image to edit can be a library image, a file on this computer or a web address. |
| `recreate` | Runs an earlier request again, exactly as it was sent. |
| `get_job`, `wait_for`, `cancel_job` | Check, wait for or stop a run. |
| `search_assets`, `get_asset`, `view_asset` | Find images in the library and look at them, with their prompt, settings and the images they came from. |
| `update_assets` | Favourite, file into folders, move to the Trash and restore. |
| `import_image` | Adds an image from a file or a web address to the library. |
| `list_folders`, `create_folder`, `update_folder`, `delete_folder` | Organise folders. Deleting a folder keeps its images. |
| `get_usage` | Spending, split by model, company, size or where it was made. |
| `get_settings` | Your defaults, which companies are set up, and the agents' limits. Read only, and never a key. |

Images come back with a small preview the agent can look at, the file's path on disk, and a link that opens the image in Openfield. Library images are also resources, `openfield://asset/<id>`, for apps that let you attach them.

Agents can't change settings, keys or their own limits, and can't delete images for good.

## Limits

Agents spend money on your keys, so **Settings > Agents > Spending by agents** sets two limits:

- **Ask before spending more than** (default $0.50). A request estimated above this is refused until the agent shows you the price and you agree. The agent then sends the price back as `confirmCost`.
- **Daily limit** (default $5). Once agents together have spent this much today, they stop making images until midnight. Runs still going count at their estimate. Clear the field for no limit.

Every tool that spends also takes `dryRun`, which only works out the price.

## Waiting for images

Tools that make images wait up to 50 seconds for them by default (`wait`, up to 600). Several apps give up on a tool call after a minute, so a slower run answers with its run id instead, and the agent picks it up with `wait_for`. Runs at the Batch speed can take hours and always answer at once.

## Turning it off, and new keys

Turning agents off ends every connection at once, and `/mcp` stops answering. The key is kept for when you turn them back on.

**Make a new key** in **Settings > Agents** disconnects every app using the old one. Set those apps up again with the new key; Claude Desktop and Codex pick it up by themselves.

## Troubleshooting

- **"Openfield isn't running."** Start it with `bun start` (or `bun dev`) in the Openfield folder, then try again. Apps using the bridge connect again on their next request.
- **"Agents are turned off in Openfield."** Turn them on in **Settings > Agents**.
- **"Openfield didn't accept this access key."** The key changed. Copy the snippet again from **Settings > Agents**.
- **"This connection to Openfield ended."** Openfield restarted or the connection sat idle for half an hour. Apps connect again on their own; if yours doesn't, restart it.
- **Codex gives up on long runs.** Codex stops a tool call after `tool_timeout_sec` (60 seconds by default). Keep `wait` under that, or raise `tool_timeout_sec` in its config.

## How it works

`/mcp` is part of the Openfield server, on the same address as the app. It checks the Host and the page origin like every other route, then the access key instead of the browser's session token. Each app gets its own session, kept in memory and ended after half an hour idle. The key lives in `config.json` beside your company keys, readable only by your user account, and is removed from logs. The tools call the same code the app does, so an agent's images, edits and folders reach open tabs as they happen.
