# Codex Creative Workspace — DESIGN.md

## 1. Product thesis

This is a local creative-production cockpit for Codex on macOS. It reduces the distance between a conversation, reference images, generated outputs, review decisions, and a protected final delivery. It is not a generic file manager and it never treats automated cleanup as authority to alter client-ready work.

Primary jobs:

1. **Collect** — locate and review images, video, audio, generations, and references without losing project context.
2. **Compose** — lay image references out on a spatial board, compare relationships, annotate intent, and attach a deliberate selection to the current Codex conversation.
3. **Deliver safely** — move work through review while `FinalDelivery`, final outputs, records, reference libraries, and today’s practice work remain protected from automatic or destructive actions.

## 2. Design principles

- **Content before chrome.** Glass is reserved for navigation, toolbars, popovers, and transient state. Media, editors, cards, and the spatial canvas use opaque surfaces.
- **One accent, explicit meaning.** Action Blue is the only interaction accent. Success, warning, reference, hold, and danger colors are semantic and always paired with text or shape.
- **Dense, not cramped.** Information is compact enough for professional review, with 40 pt minimum interactive targets and a visible 3 px keyboard focus ring.
- **Direct manipulation.** Spatial actions operate on the object under the pointer. Pan, zoom, drag, multi-select, delete-from-board, and attach-to-Codex must be reversible or source-preserving.
- **Local truth.** The interface distinguishes local draft, syncing, saved, conflicted, missing source, and failed states. It never implies that an unsent attachment was sent.
- **Calm motion.** Motion explains hierarchy or causality. It never delays asset review.

## 3. Visual system

### Color

Dark and light modes have equal hierarchy, not inverted approximations.

- Canvas: dark `#0D1016`, light `#EDF1F6`
- Opaque content: dark `#171B24`, light `#FFFFFF`
- Action Blue: dark `#0A84FF`, light `#006BD6`
- Hairlines: 9–19% neutral alpha according to hierarchy
- Chrome: 72–92% translucent neutral, always with a solid fallback

### Typography

- UI stack: Avenir Next, PingFang SC, SF Pro Text, Helvetica Neue
- Caption 11, label 12, body 13, title 15, heading 16 px
- Headings are functional labels, never marketing display type
- Filenames use truncation plus a native title tooltip; paths use a monospace stack

### Geometry

- Radius scale: 6 / 8 / 12 / 16 px
- Asset preview ratio: 16:10
- Spacing is based on a 4 px unit; common gaps are 4 / 8 / 12 / 16 / 24 px
- Interactive targets are at least 40 × 40 px

### Material

- Glass: sidebar, top bar, canvas toolbar, task bar, batch bar, popovers, dialogs, toasts
- Opaque: asset cards, inspector, canvas nodes, note editors, dense lists
- Never nest glass inside glass. A transient child uses an opaque strong chrome surface when its parent is already glass.
- `prefers-reduced-transparency` and missing `backdrop-filter` use `--chrome-solid`.

## 4. Motion and state

Timing tokens:

- 90 ms: press response
- 120 ms: hover and color state
- 150 ms: selection, focus, small surface changes
- 220 ms: popover, dialog, inspector, and view transitions

Easing uses a fast professional standard curve (`cubic-bezier(.2,0,0,1)`) and a slightly expressive exit/placement curve (`cubic-bezier(.2,.72,.2,1)`). `prefers-reduced-motion` reduces all movement to effectively zero while preserving state changes.

Every actionable component specifies: rest, hover, focus-visible, pressed, selected, disabled, busy, success, and error where applicable. Selection never relies on color alone: it uses border, soft halo, and ARIA state.

## 5. Information architecture

- **Sidebar:** project, folder, category, status, type, and low-frequency settings
- **Codex host tool rail:** a narrow right-edge launcher for Asset Library, Spatial Canvas, and native Plugin/Skill management. It is chrome, not content; every icon has a text tooltip, 40 pt target, pressed state, and keyboard focus.
- **Top bar:** current context, search, filters, sorting, grid/canvas view, creation, and tools
- **Main content:** grid, comparison surface, or project canvas — only one primary surface at a time
- **Inspector:** on-demand detail for one asset; hidden while canvas is the primary surface
- **Batch bar:** appears only during explicit selection mode and separates file operations from Codex attachment

### Host integration boundary

The default macOS adapter injects the rail through loopback-only CDP and leaves the signed ChatGPT/Codex application bundle untouched. DOM changes are idempotent, use stable semantic anchors when available, and remove all owned nodes during `destroy()`. A missing host anchor disables only the dependent enhancement.

The asset surface is a resizable complementary panel rather than a new browser destination. Asset Library and Spatial Canvas share this panel; selecting either rail icon switches the embedded private view. Plugin/Skill delegates to the existing native control instead of reimplementing host behavior.

Persistent preload or `app.asar` patching is not part of the default adapter. It can make the original Dock icon load modifications, but it also changes the signed application, interacts with the official updater, and requires a repair/uninstall path. That adapter must remain separately approved and fail closed on an unknown host version.

## 6. Project spatial canvas

The canvas is a source-preserving reference board, not an image editor.

### Data model

- One board per project, stored under the private AssetBrowser state root
- Nodes contain only a project-relative image reference or local note
- No image is copied, renamed, moved, deleted, or embedded into board JSON
- Every write includes `baseRev`; revision mismatch fails with `409` and reloads current local truth
- Writes are bounded, validated, serialized per project, and committed with temporary-file rename

### Controls

- Drag empty space: pan
- Trackpad/wheel: pan
- Command/Control + wheel: zoom around pointer
- Drag image header/body: move one or all selected nodes
- Shift or Command click: additive selection
- Shift drag empty space: marquee selection
- Double-click image: return to its current asset detail when available
- Delete/Backspace: remove reference from board only
- `0` or **Fit**: frame all nodes
- Add note: create an editable intent/review note at viewport center
- Attach to conversation: sends up to eight selected image paths to the current Codex composer, never auto-sends the message

### Spatial behavior

Viewport transform is `screen = world × scale + translation`. Zoom preserves the world point under the pointer. Node movement divides screen delta by scale. Fit computes a padded union of node bounds and caps scale to avoid over-magnifying a single item.

## 7. Accessibility and failure behavior

- Keyboard focus is always visible; canvas itself is focusable
- All icon-only controls have accessible names
- Status is expressed with text, shape, and color
- Reduced motion/transparency and increased contrast are first-class modes
- Missing images remain as references with an explicit failure state; the board is not silently rewritten
- Corrupt config, metadata, registry, or canvas JSON fails closed and remains untouched
- Destructive or automatic actions reject symlink escapes and protected creative destinations

## 8. Acceptance criteria

- Light and dark modes preserve the same hierarchy
- No visible control is smaller than 40 px in either axis when actionable
- No horizontal document overflow at supported desktop widths
- Grid and canvas can be switched without losing project or selection context
- Canvas pan, pointer-centered zoom, multi-select, drag, note editing, delete-from-board, fit, refresh, and reload persistence pass automated interaction checks
- Malicious filenames render as text; CSP blocks inline event execution
- FinalDelivery and other protected creative areas cannot be automatically organized, moved, trashed, or purged
- Installation, runtime, and uninstall modify only owned user-library paths and roll back as one transaction

## 9. Research lineage

This specification synthesizes, without copying, patterns from:

- [Apple HIG — Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Apple HIG — Motion](https://developer.apple.com/design/human-interface-guidelines/motion)
- [Awesome iOS DESIGN.md](https://github.com/Meliwat/awesome-ios-design-md)
- [Linear DESIGN.md](https://github.com/Meliwat/awesome-ios-design-md/blob/main/design-md/productivity/linear/DESIGN.md)
- [Figma DESIGN.md](https://github.com/Meliwat/awesome-ios-design-md/blob/main/design-md/productivity/figma/DESIGN.md)
- [Linear UI redesign](https://linear.app/now/how-we-redesigned-the-linear-ui)
- [Raycast visual refresh](https://www.raycast.com/blog/a-fresh-look-and-feel)
- [TapNow canvas documentation](https://docs.tapnow.ai/en/docs/canvas/explore-the-canvas)
- [Codex++ tweak lifecycle and native views](https://github.com/b-nnett/codex-plusplus)
- [Codex Plus Patcher side-panel API](https://github.com/michaelw/codex-plus-patcher)
- [Chrome DevTools Protocol — Page](https://chromedevtools.github.io/devtools-protocol/1-3/Page/)
