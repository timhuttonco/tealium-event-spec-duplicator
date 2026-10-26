# Tealium Event Spec Duplicator

Chrome extension that adds a **Duplicate** button to the top right of an Event
Spec's Edit Details panel in Tealium (`my.tealiumiq.com`, Validate → Event Specs),
the same place as the rest of the platform.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Reload your Tealium tab.

## Use

1. Go to **Validate → Event Specs** and click a spec to open it.
2. Click **Duplicate** (top right), enter the new `tealium_event` name, press Enter.
3. Click **Save / Publish** in Tealium to keep it (reload without saving to discard).

If you've edited the spec in the panel, click **Done** first and reopen it, so
the copy is guaranteed to include your edits.

## How it works

An Event Spec is two linked records in Tealium's in-memory profile:

- an event definition (`gApp.inMemoryModels.eventDefinitionCollection`): event
  name, attribute definitions (attribute, required, example), labels, notes;
- a filtered stream (`filteredStreamCollection`) named
  `Event Specification: <event>` whose rule is `tealium_event equals <event>`.

The extension clones both with new IDs (`gApp.utils.uuid()`), rewrites the event
name in the stream's name, `conditions` and `logic`, adds them to the
collections and calls `gApp.utils.setDirty(true)`. Nothing is sent to Tealium
until you save the profile yourself.

This relies on Tealium's internal, undocumented UI models, so a Tealium release
could break it. If the button stops appearing, check that
`gApp.inMemoryModels.eventDefinitionCollection` still exists in the console.
