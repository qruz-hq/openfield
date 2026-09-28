# Agents

AI apps like Claude Code, Claude Desktop, Cursor and Codex can use Openfield for you while it runs: build and run canvases while you watch, make and edit images, find and file them in your library, check prices and spending. They connect over [MCP](https://modelcontextprotocol.io), the protocol these apps use for tools.

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

## Canvases

Agents build and run canvases with you. Say "add a variation of the selected node" or "build me a moodboard canvas for these references", and the agent reads the canvas, changes it and runs it, the same way you would.

- **You see it happen.** When the canvas is open, each change appears as it's made. A pill at the top says which app is editing, with **Follow** to keep its work in view, and a tag marks the nodes it just touched. Runs it starts show on the nodes like your own.
- **Nothing is lost.** Before an app's first change to a canvas, Openfield saves the canvas as a version, "Before Claude Code", so you can go back from **Version history**.
- **"The canvas I have open."** Agents can use `active` for the canvas in the Openfield tab you used last, and see which nodes you've selected there.
- **Same rules as the editor.** Connections follow the port rules you see when dragging, nodes the agent doesn't place are put next to what they connect to, and runs skip nodes that are already up to date, for free.
- **Locked nodes stay yours.** Lock a node (or a frame, which locks everything in it) with **⇧⌘L** or its menu, and it keeps its images: no run, yours or an agent's, makes new ones, and the nodes after it use the ones it has. Agents can read a locked node and connect to it, but can't change, move, run, delete, lock or unlock it, and can't restore a version that would change it. Only you can unlock it.

A canvas is built from nodes: **Prompt** hands text on, **Generate** and **Variations** make images, **Upload** and **Assets** hand on images from the library, and **Note**, **Frame**, **Text** and **Shape** are for layout. Each node has input and output ports; a connection goes from an output to an input of the same kind, written `"node.port"`:

```json
{
  "canvas": "active",
  "edits": [
    { "op": "add_node", "as": "p", "type": "prompt", "params": { "text": "A stoneware mug on linen" } },
    { "op": "add_node", "as": "g", "type": "image.generate", "params": { "aspect": "1:1" } },
    { "connect": "p.text", "to": "g.prompt" }
  ]
}
```

`as` names a new node so later edits in the same batch can refer to it. A batch applies whole or not at all; a refused edit says which one and why. `list_node_types` lists every type, its ports and settings.

Edits apply to the canvas as it is when they arrive, so panning, zooming or changing things in your tab while an agent works never gets its changes refused. The answer says what changed since the agent last read the canvas, such as "Since your last read: Key visual renamed, the view moved." An agent that wants its batch left alone if anything changed sends `onlyIfUnchanged: true`.

New nodes go where they fit at the size they show: an image card at its aspect ratio, or its image's shape once it has one. A position given by hand that lands on another node moves to the nearest free spot, and the answer says by how much; `exact: true` keeps it. A frame grows to hold whatever an agent puts in it, reaching left or up when it has to without moving anything on screen.

| Tool | Does |
|---|---|
| `list_canvases`, `create_canvas`, `get_canvas` | Find, make (blank or from a template) and read canvases. `get_canvas` gives each node's box (where it sits and how big it is), its frame, its settings and whether it's done, out of date or needs something. |
| `edit_canvas` | A batch of changes: add, change, move and remove nodes, connect and disconnect, rename. |
| `add_nodes`, `connect`, `update_node`, `move_node`, `delete_nodes` | The same changes one kind at a time. |
| `run_canvas`, `get_run`, `stop_run` | Run all of a canvas, one node, a node and what follows it, or a selection; follow the run; stop it or one node. Goes through the same limits as `generate_image`. |
| `list_versions`, `save_version`, `restore_version` | Versions. Restoring saves what's there first, and open tabs show the restore live. |
| `rename_canvas`, `duplicate_canvas`, `delete_canvas` | Tidy up. Deleting a canvas keeps its images in the library. |
| `list_node_types` | Every node type, its ports and settings. |
| `get_active_canvas`, `show` | What you have open and selected; open a canvas, image or page in your tab. |

Canvases are also resources, `openfield://canvas/<id>`.

## Images and the library

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

Agents can't change settings, keys, their own limits or what they're allowed to do, and can't delete images for good.

## What agents may do

**Settings > Agents** lists every action agents can take, in five groups: Look around, Build canvases, Make images, Organise library and Delete things. Each action, and each group as a whole, is set to one of:

- **Allow**: the agent goes ahead without asking.
- **Ask**: Openfield checks with you every time. Apps that can show a prompt (MCP elicitation, as in Claude Code and Cursor) ask you there, with the price for anything that spends. In apps that can't, the agent has to ask you in its chat and say you agreed.
- **Default**: Openfield's own rule, shown under each action. Most actions are allowed. Making images and running canvases ask above your amount (below). Deleting folders and canvases asks.

A group's switch sets every action in it; when they differ it shows none picked. Whatever you choose, the daily limit still applies.

## Limits

Agents spend money on your keys, so **Settings > Agents > Spending by agents** sets two limits:

- **Ask before spending more than** (default $0.50). What Default means for Making images and Running canvases: anything estimated above this waits for your OK, in the app's prompt, or in the agent's chat when the app can't show one (the agent then sends the price back as `confirmCost`).
- **Daily limit** (default $5). Once agents together have spent this much today, they stop making images until midnight. Work still going counts at its estimate, and a canvas run counts at its whole estimate until it ends. Two requests at once are checked one after the other, so they can't both slip under it. A request whose price Openfield can't work out is refused once the limit is reached. Clear the field for no limit.

Every tool that spends also takes `dryRun`, which only works out the price.

## Waiting for images

Tools that make images wait up to 50 seconds for them by default (`wait`, up to 600). Several apps give up on a tool call after a minute, so a slower run answers with its run id instead, and the agent picks it up with `wait_for` (or `get_run` for a canvas). Runs at the Batch speed can take hours and always answer at once.

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

`/mcp` is part of the Openfield server, on the same address as the app. It checks the Host and the page origin like every other route, then the access key instead of the browser's session token. Each app gets its own session, kept in memory and ended after half an hour idle. The key lives in `config.json` beside your company keys, readable only by your user account, and is removed from logs. The tools call the same code the app does, so an agent's images, canvas edits, runs and folders reach open tabs as they happen. Canvas edits are compiled on the server with the editor's own rules and sent to every open tab as the document changes to replay.
