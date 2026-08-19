# Asset Console design benchmark

This document records the external design rules adopted by the local macOS UI. It is a translation into this product's own system, not a visual copy of another product.

## Sources and extracted rules

### Apple Human Interface Guidelines — Materials

Source: <https://developer.apple.com/design/human-interface-guidelines/materials>

- Liquid Glass is a functional layer for navigation and controls, not a content-card treatment.
- Use the regular, more legible material for sidebars, toolbars, popovers, and surfaces with substantial text.
- Use clear glass only above visually rich media and pair it with dimming when contrast needs help.
- Standard or opaque materials should structure the content layer.
- Reduced Transparency and Increased Contrast must produce deliberate solid fallbacks.

Adopted here: glass is limited to sidebar, top chrome, batch/action bar, popovers, dialogs, and toasts. Asset tiles, media, metadata, comparison views, and inspector content remain opaque.

### Linear — interface redesign and 2026 refresh

Sources:

- <https://linear.app/now/how-we-redesigned-the-linear-ui>
- <https://linear.app/changelog/2026-03-12-ui-refresh>

- Improve hierarchy, balance, and density together; do not trade density for decorative whitespace.
- Treat the sidebar and headers as one coherent global chrome.
- Reduce borders and visual noise by aligning labels, icons, and controls precisely.
- Make navigation slightly dimmer than primary content.
- Build light and dark themes from one token language.

Adopted here: a quieter sidebar, one header system, four radii, one neutral hairline family, shared light/dark tokens, and content that visually outranks chrome.

### Raycast — fast, simple, delightful

Source: <https://www.raycast.com/blog/a-fresh-look-and-feel>

- Give the main search action visual priority when search is the dominant workflow.
- Consolidate contextual actions into a predictable action bar rather than scattering equal-weight buttons.
- Use a consistent icon stroke and corner system.
- Preserve keyboard-first operation and expose shortcuts where people learn them in context.

Adopted here: search is the toolbar anchor, secondary actions use one ghost-control family, batch/context actions use a dedicated bar, and `⌘K`, move, compare, select-all, and escape remain visible and testable.

### Craft — native patterns before spectacle

Source: <https://www.craft.do/blog/vision-pro-the-begginings>

- Start with platform human-interface patterns instead of inventing a separate interaction language.
- Polish comes from material restraint, toolbar quality, rounded geometry, hover/focus behavior, and detail consistency.
- Separate platform adaptation, correctness, and the final visual refinement phase.

Adopted here: macOS-native typography and control rhythm, restrained material use, accessible hover/focus states, and visual work kept independent from platform and data-safety logic.

## Product-specific invariants

1. Glass never replaces readable asset content.
2. There is one system-blue accent plus semantic status colors; no rainbow chrome.
3. Primary content uses opaque surfaces and carries the strongest contrast.
4. The sidebar is quieter than the canvas.
5. Search is the dominant toolbar control; secondary actions share one visual weight.
6. Body text is at least 13px and auxiliary text at least 11px.
7. Focus remains a visible 3px ring; hit targets remain at least 40px where pointer/touch ambiguity exists.
8. Reduced Motion and Reduced Transparency are first-class modes, not emergency fallbacks.
9. FinalDelivery and protected creative locations are a data rule and must never be weakened by UI convenience.
10. A visual change is not accepted without light/dark screenshots and a functional regression pass.
