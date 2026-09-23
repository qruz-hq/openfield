# @openfield/ui

Design tokens, the Tailwind theme and the presentational primitives for Openfield. Every value comes
from `design.pen` (the Foundations and Primitives boards). Components take props and raise events:
no data fetching, no routing, no API client.

## Setup

Import the stylesheet once, from the app's entry:

```ts
import "@openfield/ui/styles.css";
```

It pulls in Tailwind, the self-hosted Inter and JetBrains Mono fonts, and the `--of-*` tokens (PRD §2.2).
Tailwind scans this package on its own, so apps don't need an extra `@source`.

Put a `TooltipProvider` near the root if you use `Tooltip`.

### Themes

Dark is the default. Set `data-theme` on `<html>` from the Appearance setting:

| Setting | Attribute | Result |
|---|---|---|
| Dark | `data-theme="dark"` | dark |
| Light | `data-theme="light"` | light |
| System | `data-theme="system"` (or none) | follows the OS, dark when it has no preference |

Tokens are written as `light-dark(light, dark)`, so the page needs a 2024 or newer browser
(Chrome 123, Safari 17.5, Firefox 120).

### Reading the classes

- One spacing unit is one pixel: `p-12`, `gap-6`, `h-40`, `w-352` are the numbers on the design nodes.
- Radii are named by their size: `rounded-8`, `rounded-10`, `rounded-12`, `rounded-full` for 999.
- Colors are the token names: `bg-elevated-2`, `text-text-secondary`, `bg-accent-soft`. Tailwind's own
  palette is removed, so a raw color can't slip in.
- Strokes use `inset-ring inset-ring-border`. Like design.pen strokes, they sit inside the box and don't
  change its size.
- Type roles: `text-display`, `text-sheet-title`, `text-page-title`, `text-group-title`, `text-button-l`,
  `text-body-strong`, `text-body-medium`, `text-body`, `text-small`, `text-caption`, `text-micro`,
  `text-caps` (small caps, typed in sentence case) and `text-mono-11/12/13` for raw numbers only.
- `shadow-popover` is the one floating shadow (0 16 40). `backdrop-blur-chip` (8) and `backdrop-blur-panel`
  (10.45) are the two blurs.
- Anything that sits on a photo uses the `overlay` tokens (`bg-overlay`, `text-overlay-fg`,
  `bg-overlay-scrim`), which stay dark in both themes.

Use `cn()` from this package to merge classes. It knows the roles above.

### Copy

Components never hardcode words. Labels, including accessible names such as `closeLabel` or
`decrementLabel`, come in as props from the string catalogue.

## Design name to export

| design.pen | Export |
|---|---|
| Brand / Mark / 18, 24, 56 | `<BrandMark size={18} />` |
| Brand / Lockup | `<BrandLockup />` |
| Logo tile / {company} | `<ProviderLogo provider="openai" variant="tile" />` |
| Logo glyph / {company} | `<ProviderLogo provider="google" />` |
| Aspect glyph / {ratio}, Auto | `<AspectGlyph ratio="3:4" />`, `ratio="auto"` |
| Button / Primary / M | `<Button>` |
| Button / Primary / M / Icon | `<Button icon={Sparkles}>` |
| Button / Primary / M / Icon / Price | `<Button icon={RefreshCw} price="~$0.04">` |
| Button / Primary / M / Disabled | `<Button disabled>` |
| Button / Secondary / M | `<Button variant="secondary">` |
| Button / Ghost / M | `<Button variant="ghost">` |
| Button / Danger / M | `<Button variant="danger">` |
| Button / Danger ghost / M | `<Button variant="danger-ghost">` |
| Button / * / S | `<Button size="s">` |
| Button / Secondary / L / Icon | `<Button variant="secondary" size="l" icon={Download}>` |
| Button / Primary / XL | `<Button size="xl" icon={KeyRound}>` |
| Button / Primary / Field, Secondary / Field | `<Button size="field">`, `variant="secondary"` |
| Button / Overlay / S / Icon | `<Button variant="overlay" size="s" icon={Brush}>` |
| Button / Link / S | `<Button variant="link">` |
| Button / Ghost accent / S / Icon | `<Button variant="ghost-accent" size="s" icon={RefreshCw}>` |
| Icon button / Ghost / 24, 28, 32, 40 | `<IconButton size={28} icon={Search} label="…" />` |
| Icon button / Ghost / 28 / Active | `<IconButton active … />` |
| Icon button / Secondary / 32 (attach), 40, 44×40 | `<IconButton variant="secondary" size={32} />`, `size="44x40"` |
| Icon button / Secondary / 40 / Danger | `<IconButton variant="secondary" size={40} tone="danger" />` |
| Icon button / Overlay / 32, 38 | `<IconButton variant="overlay" size={38} />` |
| Icon button / Round / 30, 32 | `<IconButton variant="round" size={30} />` |
| Icon button / Tool / 36, / Active | `<IconButton variant="tool" />`, `active` |
| Icon button / Accent / 40 (submit) | `<IconButton variant="accent" icon={Sparkles} />` |
| Chip / Setting / Default | `<Chip icon={RectangleVertical} value="3:4" />` |
| Chip / Setting / With label | `<Chip icon={Sparkles} label="Enhance" value="Off" />` |
| Chip / Setting / Active | `<Chip … open />`, or automatic as a `PopoverTrigger` |
| Chip / Setting / Muted | `<Chip … muted />` |
| Chip / Setting / Model, / Model / Open | `<ModelChip provider="openai" name="…" />`, `open` |
| Chip / Setting / Model / Empty | `<ModelChip name="Pick a model" />` |
| Chip / Setting / Stepper | `<StepperChip value={2} … />` |
| Chip / Mini / Outline | `<MiniChip icon={Copy} label="Copy" />` |
| Chip / Mini / With glyph | `<MiniChip provider="openai" label="…" />` |
| Chip / Model tag | `<ModelTag provider="openai" name="…" price="~$0.04" />` |
| Pill / Filter / Active, Idle | `<FilterPill active>` |
| Pill / Status / Connected, Not connected, Error, Checking, Set outside | `<StatusPill status="connected">` |
| Pill / Spend | `<SpendPill label="Spent today" amount="$0.42" />` |
| Pill / Tile status / Generating, Queued | `<TileStatusPill status="generating">` |
| Pill / Tile status / Cancel | `<TileCancelPill>` |
| Badge / Accent, Neutral, Danger, Count | `<Badge variant="accent">`, `caps` for small caps |
| Badge / Check / 22 | `<CheckBadge />` |
| Input / Text, Input / Text / Mono | `<Input />`, `mono`, `leading="$"` |
| Input / Search | `<SearchInput />` |
| Input / Search / Header | `<SearchInput variant="header" />` |
| Input / Key / Filled, Empty, Error, Locked | `<KeyInput />`, `masked`, `invalid`, `locked` |
| Input / Textarea | `<Textarea counter maxLength={400} />` |
| Input / Select | `<Select><SelectItem value="png">PNG</SelectItem></Select>` |
| Form / Field / Textarea, Select, Segmented, Slider | `<Field label description>{control}</Field>` |
| Form / Field / Switch | `<Field layout="inline" …><Switch /></Field>` |
| Form / Field / Slider control row | `<SliderRow valueLabel="0.6" />` |
| Toggle / On, Off | `<Switch />` |
| Checkbox / On, Off, Mixed | `<Checkbox checked />`, `checked="indeterminate"` |
| Checkbox / On image | `<Checkbox onImage />` |
| Radio / On, Off | `<RadioGroup><Radio value="a" /></RadioGroup>` |
| Segmented / 2, 3 and Segmented / Item | `<Segmented><SegmentedItem value="soft">` |
| Slider / Track | `<Slider />` |
| Slider / Zoom | `<ZoomSlider />` |
| Stepper / M | `<Stepper value={4} … />` |
| Text / Keycap | `<Keycap>⌘K</Keycap>` (use "enter", JetBrains Mono has no ↵) |
| Progress / Bar | `<ProgressBar value={0.6} />` |
| Feedback / Spinner | `<Spinner />` |
| Tabs / Pill | `<Tabs><TabsList><TabsTrigger>` |
| Detail tabs (Segmented / 3 as tabs) | `<TabsList variant="segmented">` |
| Step indicator / Current, Upcoming, Done + Step connector | `<Steps><Step state="current" /><StepConnector /></Steps>` |
| Row / Key value / Text, Mono, With glyph | `<KeyValueList><KeyValueRow label value mono glyph /></KeyValueList>` |
| Row / Section label | `<SectionLabel>Details</SectionLabel>` |
| Row / Group label | `<GroupLabel>` |
| Row / Group header | `<GroupHeader label action />` |
| Row / Nav / Active, Idle | `<NavRow icon label count active />` (`asChild` for router links) |
| Row / Setting / Text | `<SettingText title description />` |
| Row / Command / Default, Active, Model | `<CommandRow leading label meta shortcut active />` |
| App / Nav item / Active, Idle | `<TopNavItem active>` |
| Caption / Model / Inline, Stacked | `<ModelCaption provider name cost layout="stacked" />`, `onImage` |
| Text / Highlight | `<Highlight>` |
| Divider / Horizontal, / Inset, / Vertical / 20, 24 | `<Divider />`, `inset`, `orientation="vertical" size={20}` |
| Surface / Card, Block, Popover, Floating bar, Panel / Side | `<Surface variant="card">`, `"block"`, `"popover"`, `"floating-bar"`, `"panel"` |
| Popover (any composer popover) | `<Popover><PopoverTrigger /><PopoverContent className="w-240" /></Popover>` |
| Popover / Option row / Default, Selected, Disabled, With subtitle | `<OptionRow title subtitle leading price selected disabled />` |
| Menu / Container | `<Menu><MenuTrigger /><MenuContent>` |
| Menu / Item, / Item / Icon, / Item / Danger | `<MenuItem>`, `icon shortcut`, `danger` |
| Divider / Horizontal / Inset (in a menu) | `<MenuSeparator />` |
| Feedback / Tooltip | `<Tooltip content="Add to favorites" shortcut="F">` |
| Feedback / Toast | `toast.custom((id) => <Toast message actionLabel onClose />)` with sonner |
| Modal / Shell | `<Modal><ModalContent title closeLabel><ModalDescription /><ModalFooter /></ModalContent></Modal>` |
| Banner / Info, Error, Offline | `<Banner variant="info" message onDismiss dismissLabel />` |
| Empty state / Page | `<EmptyStatePage title body actions />` |
| Empty state / Inline | `<EmptyStateInline icon title body actions />` |

## Where code differs from design.pen

The contrast test (`test/contrast.test.ts`) checks every text and control pair in both themes against
WCAG 2.2 AA. Where the design failed, the token moved, as PRD §2.11 asks:

| Token | design.pen | Code | Why |
|---|---|---|---|
| `text-tertiary` (dark) | `#F5F6F761` (38%) | `#F5F6F77D` (49%) | 3.3:1 on the page; body text needs 4.5:1 |
| `danger` (dark) | `#F2545B` | `#F35A61` | 4.4:1 on danger-soft over a card |
| Danger button label | `text-primary` | `danger-fg` (`#14161A`) | light text on the red is 3.1:1 |
| Unchecked checkbox and radio edge | `border-strong` | `control-line` (36% white) | 1.6:1; a control's edge needs 3:1 |
| Tile hover scrim | `scrim` (55%) | `overlay-scrim` (58%) | keeps white captions at 4.5:1 on a white photo |

Hover states aren't designed. The ones here only change a fill or a ring and never move anything.
